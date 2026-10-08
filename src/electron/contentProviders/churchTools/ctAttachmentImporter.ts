import fs from "fs"
import path from "path"
import { uid } from "uid"
import { ToMain } from "../../../types/IPC/ToMain"
import type { Show } from "../../../types/Show"
import { sendToMain } from "../../IPC/main"
import { importShow } from "../../data/import"
import { getDataFolderPath, sanitizeFileName } from "../../utils/files"

export type CtDownloadedAttachment = {
    name: string
    localPath: string
    isVideo: boolean
}

export function buildVideoShow(filename: string, localPath: string): { showId: string; show: Show } {
    const slideId = uid()
    const mediaId = uid()
    const layoutId = uid()
    const show: Show = {
        name: filename,
        category: "churchtools",
        timestamps: { created: Date.now(), modified: null, used: null },
        meta: { title: filename },
        settings: { activeLayout: layoutId, template: null },
        layouts: { [layoutId]: { name: "Default", notes: "", slides: [{ id: slideId, background: mediaId }] } },
        slides: { [slideId]: { group: filename, color: null, settings: {}, notes: "", items: [] } },
        media: { [mediaId]: { name: filename, path: localPath, type: "video", loop: false } as any }
    }
    return { showId: `ctvideo_${uid(8)}`, show }
}

function normalizeDomainBase(domain: string): string {
    const clean = String(domain || "").trim().replace(/\/+$/, "")
    if (!clean) return ""
    if (/^https?:\/\//i.test(clean)) return clean
    return `https://${clean}`
}

function extractHashFilename(source: any): string {
    const direct = String(source?.filename ?? "").trim()
    if (direct && !/[\\/]/.test(direct)) return direct

    const rawUrls = [source?.frontendUrl, source?.apiUrl, source?.downloadUrl, source?.url].map((u) => String(u ?? "").trim()).filter(Boolean)
    for (const raw of rawUrls) {
        try {
            const url = new URL(raw)
            const filename = String(url.searchParams.get("filename") ?? "").trim()
            if (filename) return filename
        } catch {
            const match = raw.match(/[?&]filename=([^&]+)/i)
            if (match?.[1]) {
                try {
                    return decodeURIComponent(match[1])
                } catch {
                    return match[1]
                }
            }
        }
    }

    return ""
}

function extractAttachmentId(source: any): string {
    const direct = String(source?.id ?? source?.fileId ?? "").trim()
    if (direct) return direct

    const rawUrls = [source?.frontendUrl, source?.apiUrl, source?.downloadUrl, source?.url].map((u) => String(u ?? "").trim()).filter(Boolean)
    for (const raw of rawUrls) {
        try {
            const url = new URL(raw)
            const queryId = String(url.searchParams.get("id") ?? "").trim()
            if (queryId) return queryId

            const serviceMatch = url.pathname.match(/\/service\/(\d+)/i)
            if (serviceMatch?.[1]) return serviceMatch[1].trim()

            const filesMatch = url.pathname.match(/\/files\/(\d+)/i)
            if (filesMatch?.[1]) return filesMatch[1].trim()
        } catch {
            const queryMatch = raw.match(/[?&]id=(\d+)/i)
            if (queryMatch?.[1]) return queryMatch[1].trim()
        }
    }

    return ""
}

function buildChurchserviceDownloadUrl(domain: string, source: any): string {
    const id = extractAttachmentId(source)
    const filenameHash = extractHashFilename(source)
    const base = normalizeDomainBase(domain)
    if (!id || !filenameHash || !base) return ""
    return `${base}/?q=churchservice/filedownload&id=${encodeURIComponent(id)}&filename=${encodeURIComponent(filenameHash)}`
}

function isLikelyHtml(buffer: Buffer): boolean {
    const prefix = buffer.toString("utf8", 0, Math.min(buffer.length, 256)).trimStart().toLowerCase()
    return prefix.startsWith("<!doctype html") || prefix.startsWith("<html") || prefix.startsWith("<head")
}

function isValidAttachmentPayload(filePath: string, filename: string): boolean {
    try {
        const fsSync = require("fs")
        if (!fsSync.existsSync(filePath)) return false

        const stat = fsSync.statSync(filePath)
        if (!stat || stat.size <= 0) return false

        const ext = path.extname(filename).toLowerCase()
        const fd = fsSync.openSync(filePath, "r")
        const header = Buffer.alloc(16)
        const readBytes = fsSync.readSync(fd, header, 0, header.length, 0)
        fsSync.closeSync(fd)

        if (readBytes <= 0) return false
        if (isLikelyHtml(header)) return false

        if (ext === ".ppt" || ext === ".pptx") {
            // PPTX files are zip containers.
            return header[0] === 0x50 && header[1] === 0x4b
        }

        if (ext === ".pdf") {
            return header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46
        }

        if ([".mp4", ".mov", ".m4v"].includes(ext)) {
            // ISO base media files contain "ftyp" near the beginning.
            return header.toString("ascii", 4, 8) === "ftyp"
        }

        return true
    } catch {
        return false
    }
}

function saveResponseToFile(response: any, destPath: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const fsSync = require("fs")
        const file = fsSync.createWriteStream(destPath)
        response.pipe(file)
        file.on("finish", () => {
            file.close()
            resolve(fsSync.existsSync(destPath) && fsSync.statSync(destPath).size > 1000)
        })
        file.on("error", () => resolve(false))
        response.on("error", () => resolve(false))
    })
}

function formatHeaders(headers: any): string {
    try {
        return JSON.stringify(headers ?? {})
    } catch {
        return "{}"
    }
}

function describePayload(filePath: string): string {
    try {
        const fsSync = require("fs")
        if (!fsSync.existsSync(filePath)) return "payload=missing"
        const stat = fsSync.statSync(filePath)
        const body: Buffer = fsSync.readFileSync(filePath)

        const head = body.subarray(0, Math.min(body.length, 128))
        const hex = head.subarray(0, 16).toString("hex")
        const text = head
            .toString("utf8")
            .replace(/[\r\n\t]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120)

        // Include complete textual payload for diagnostics when CT serves HTML/JSON instead of binary.
        const fullText = body.toString("utf8")

        return `size=${stat.size} bytes headHex=${hex} headText="${text}" fullText=${JSON.stringify(fullText)}`
    } catch {
        return "payload=unreadable"
    }
}

function removeInvalidPayload(filePath: string): void {
    try {
        const fsSync = require("fs")
        if (fsSync.existsSync(filePath)) fsSync.unlinkSync(filePath)
    } catch {}
}

function buildCookieHeader(setCookieHeader: string[] | string | undefined): string {
    const cookies = (Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [])
        .map((c) => String(c).split(";")[0])
        .filter(Boolean)
    return cookies.join("; ")
}

function extractCtV2Cookie(cookieHeader: string): string {
    if (!cookieHeader) return ""
    const parts = cookieHeader.split(";").map((p) => p.trim())
    const keep = parts.filter((p) => /^ChurchToolsV2_/i.test(p))
    return keep.join("; ")
}

function randomBrowserTabId(): string {
    return String(Math.floor(Math.random() * 2_000_000_000) + 1)
}

function bootstrapCtBrowserSessionCookie(domain: string, token: string): Promise<string> {
    return new Promise((resolve) => {
        const https = require("https")

        const base = normalizeDomainBase(domain)
        if (!base) return resolve("")
        const parsed = new URL(base)
        const pollPath =
            "/api/pollfornews?domain_types%5B%5D=eventchat&domain_types%5B%5D=event_service&domain_types%5B%5D=event_fact&domain_types%5B%5D=item&domain_types%5B%5D=agenda&domain_types%5B%5D=song&since=1970-01-01T00:00:00.000Z"

        const req = https.request(
            {
                hostname: parsed.hostname,
                port: parsed.port ? Number(parsed.port) : 443,
                path: pollPath,
                method: "GET",
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json, text/plain, */*",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0",
                    BROWSERTABID: randomBrowserTabId(),
                    Referer: `${base}/?q=churchservice`
                }
            },
            (res: any) => {
                const status = Number(res.statusCode || 0)
                const cookieHeader = buildCookieHeader(res.headers?.["set-cookie"])
                const v2Cookie = extractCtV2Cookie(cookieHeader)
                console.info(
                    `ChurchTools: session bootstrap pollfornews status=${status} ctV2Cookie=${v2Cookie ? "yes" : "no"} headers=${formatHeaders(
                        res.headers
                    )}`
                )
                res.resume()
                resolve(v2Cookie)
            }
        )

        req.on("error", (err: any) => {
            console.info(`ChurchTools: session bootstrap pollfornews error=${err?.message || "unknown"}`)
            resolve("")
        })

        req.end()
    })
}

// CT file downloads use a 2-step session: first request returns Set-Cookie, second with that cookie returns the file.
function downloadCtFile(
    _domain: string,
    token: string,
    downloadUrl: string,
    destPath: string,
    filename: string,
    browserSessionCookie = ""
): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const https = require("https")
        const parsed = new URL(downloadUrl)
        const baseHeaders: Record<string, string> = { Authorization: `Bearer ${token}`, "User-Agent": "FreeShow/1.0", Accept: "*/*" }
        if (browserSessionCookie) baseHeaders.Cookie = browserSessionCookie
        const requestPath = parsed.pathname + parsed.search

        const req1 = https.request(
            { hostname: parsed.hostname, port: parsed.port ? Number(parsed.port) : 443, path: requestPath, method: "GET", headers: baseHeaders },
            (res1: any) => {
                const setCookie: string = ((res1.headers["set-cookie"] ?? []) as string[]).map((c) => c.split(";")[0]).join("; ")
                const step1Status = Number(res1.statusCode || 0)
                console.info(
                    `ChurchTools: download step1 status=${step1Status} cookie=${setCookie ? "yes" : "no"} url=${parsed.origin}${requestPath} headers=${formatHeaders(res1.headers)}`
                )

                if (step1Status === 200) {
                    void saveResponseToFile(res1, destPath).then((saved) => {
                        if (!saved) return resolve(false)
                        if (!isValidAttachmentPayload(destPath, filename)) {
                            const contentType = String(res1.headers?.["content-type"] ?? "")
                            const info = describePayload(destPath)
                            console.warn(
                                `ChurchTools: downloaded payload rejected (unexpected content) status=${step1Status} url=${parsed.origin}${requestPath} file="${filename}" contentType="${contentType}" headers=${formatHeaders(res1.headers)} ${info}`
                            )
                            removeInvalidPayload(destPath)
                            return resolve(false)
                        }
                        resolve(true)
                    })
                    return
                }

                res1.resume()

                const req2 = https.request(
                    {
                        hostname: parsed.hostname,
                        port: parsed.port ? Number(parsed.port) : 443,
                        path: requestPath,
                        method: "GET",
                        headers: { ...baseHeaders, Cookie: setCookie }
                    },
                    (res2: any) => {
                        const step2Status = Number(res2.statusCode || 0)
                        if (step2Status !== 200) {
                            console.info(
                                `ChurchTools: download step2 status=${step2Status} url=${parsed.origin}${requestPath} headers=${formatHeaders(res2.headers)}`
                            )
                        }
                        if (res2.statusCode !== 200) {
                            res2.resume()
                            return resolve(false)
                        }
                        void saveResponseToFile(res2, destPath).then((saved) => {
                            if (!saved) return resolve(false)
                            if (!isValidAttachmentPayload(destPath, filename)) {
                                const contentType = String(res2.headers?.["content-type"] ?? "")
                                const info = describePayload(destPath)
                                console.warn(
                                    `ChurchTools: downloaded payload rejected (unexpected content) status=${step2Status} url=${parsed.origin}${requestPath} file="${filename}" contentType="${contentType}" headers=${formatHeaders(res2.headers)} ${info}`
                                )
                                removeInvalidPayload(destPath)
                                return resolve(false)
                            }
                            resolve(true)
                        })
                    }
                )
                req2.on("error", (err: any) => {
                    console.info(`ChurchTools: download step2 request error=${err?.message || "unknown"} url=${parsed.origin}${requestPath}`)
                    resolve(false)
                })
                req2.end()
            }
        )

        req1.on("error", (err: any) => {
            console.info(`ChurchTools: download step1 request error=${err?.message || "unknown"} url=${parsed.origin}${requestPath}`)
            resolve(false)
        })
        req1.end()
    })
}

export async function fetchEventAttachments(domain: string, token: string, eventId: number, eventFiles: any[]): Promise<CtDownloadedAttachment[]> {
    console.info(`ChurchTools: event ${eventId} attachments: ${eventFiles.length}`)
    if (!eventFiles.length) return []

    const destFolder = getDataFolderPath("imports", "ChurchTools")
    await fs.promises.mkdir(destFolder, { recursive: true })
    const browserSessionCookie = await bootstrapCtBrowserSessionCookie(domain, token)

    const downloaded: CtDownloadedAttachment[] = []
    for (const file of eventFiles) {
        const source = { ...(file || {}), ...((file && file.attributes) || {}) }
        const name = String(source?.title ?? source?.name ?? source?.fileName ?? source?.filename ?? "").trim()
        if (!name || !/\.(pptx?|pdf|mp4|mov|avi|mkv|webm|m4v)$/i.test(name)) continue

        const preferredChurchserviceUrl = buildChurchserviceDownloadUrl(domain, source)
        const downloadUrl = String(preferredChurchserviceUrl || source?.frontendUrl || source?.apiUrl || "").trim()
        if (!downloadUrl) continue

        if (preferredChurchserviceUrl) {
            console.info(`ChurchTools: using preferred churchservice URL for attachment id=${String(source?.id ?? "")}`)
        }

        const localPath = path.join(destFolder, sanitizeFileName(name))
        const isVideo = /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(name)
        const ok = await downloadCtFile(domain, token, downloadUrl, localPath, name, browserSessionCookie)
        if (ok) {
            downloaded.push({ name, localPath, isVideo })
            console.info(`ChurchTools: downloaded attachment "${name}"`)
        } else {
            console.warn(`ChurchTools: download failed for "${name}"`)
        }
    }

    return downloaded
}

export async function appendAttachmentImports(
    attachments: CtDownloadedAttachment[],
    dateLabel: string,
    buildHeaderShow: (title: string, note: string, dateLabel: string) => { showId: string; show: Show },
    msOfficePptConverter: ((inputPath: string) => Promise<any>) | null
): Promise<{ shows: any[]; projectItems: any[] }> {
    const shows: any[] = []
    const projectItems: any[] = []

    for (const att of attachments) {
        const addAttachmentPlaceholder = (reason: string) => {
            const errorNote = [
                "ChurchTools attachment import error",
                `File: ${att.name}`,
                `Path: ${att.localPath}`,
                `Reason: ${reason}`,
                `Time: ${new Date().toISOString()}`
            ].join("\n")
            const { showId, show } = buildHeaderShow(`Attachment import failed: ${att.name}`, errorNote, dateLabel)
            shows.push({ id: showId, ...show })
            projectItems.push({ type: "show", id: showId, scheduleLength: 0 })
        }

        if (att.isVideo) {
            const { showId, show } = buildVideoShow(att.name, att.localPath)
            shows.push({ id: showId, ...show })
            projectItems.push({ type: "show", id: showId, scheduleLength: 0 })
        } else {
            const lowerName = att.name.toLowerCase()
            try {
                if (/\.pdf$/i.test(lowerName)) {
                    sendToMain(ToMain.IMPORT2, { channel: "pdf", data: [att.localPath] })
                } else if (/\.(ppt|pptx)$/i.test(lowerName)) {
                    if (msOfficePptConverter) {
                        const converted = await msOfficePptConverter(att.localPath)
                        if (converted === false) addAttachmentPlaceholder("PowerPoint conversion failed")
                    } else {
                        await importShow("powerpoint", [att.localPath], {})
                    }
                } else {
                    addAttachmentPlaceholder("Unsupported attachment type")
                }
            } catch (err: any) {
                addAttachmentPlaceholder(err?.message || "Unexpected conversion error")
            }
            projectItems.push({ type: "section", id: uid(5), name: `📎 ${att.name}`, notes: att.localPath, scheduleLength: 0 })
        }
    }

    return { shows, projectItems }
}
