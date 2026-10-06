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

function downloadCtFile(_domain: string, token: string, frontendUrl: string, destPath: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const https = require("https")
        const fsSync = require("fs")
        const parsed = new URL(frontendUrl)
        const baseHeaders = { Authorization: `Bearer ${token}`, "User-Agent": "FreeShow/1.0", Accept: "*/*" }

        const req1 = https.request({ hostname: parsed.hostname, port: 443, path: parsed.pathname + parsed.search, method: "GET", headers: baseHeaders }, (res1: any) => {
            const setCookie: string = ((res1.headers["set-cookie"] ?? []) as string[]).map((c) => c.split(";")[0]).join("; ")
            res1.resume()

            const req2 = https.request({ hostname: parsed.hostname, port: 443, path: parsed.pathname + parsed.search, method: "GET", headers: { ...baseHeaders, Cookie: setCookie } }, (res2: any) => {
                if (res2.statusCode !== 200) { res2.resume(); return resolve(false) }
                const file = fsSync.createWriteStream(destPath)
                res2.pipe(file)
                file.on("finish", () => { file.close(); resolve(fsSync.statSync(destPath).size > 1000) })
                file.on("error", () => resolve(false))
            })
            req2.on("error", () => resolve(false))
            req2.end()
        })
        req1.on("error", () => resolve(false))
        req1.end()
    })
}

export async function fetchEventAttachments(domain: string, token: string, eventId: number, eventFiles: any[]): Promise<CtDownloadedAttachment[]> {
    console.info(`ChurchTools: event ${eventId} attachments: ${eventFiles.length}`)
    if (!eventFiles.length) return []

    const destFolder = getDataFolderPath("imports", "ChurchTools")
    await fs.promises.mkdir(destFolder, { recursive: true })

    const downloaded: CtDownloadedAttachment[] = []
    for (const file of eventFiles) {
        const name = (file.title ?? file.name ?? "").trim()
        if (!name || !/\.(pptx?|pdf|mp4|mov|avi|mkv|webm|m4v)$/i.test(name)) continue
        const downloadUrl: string = file.frontendUrl ?? file.apiUrl ?? ""
        if (!downloadUrl) continue
        const localPath = path.join(destFolder, sanitizeFileName(name))
        const isVideo = /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(name)
        const ok = await downloadCtFile(domain, token, downloadUrl, localPath)
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
