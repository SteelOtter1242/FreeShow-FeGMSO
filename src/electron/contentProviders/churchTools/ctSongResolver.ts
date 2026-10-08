import fs from "fs"
import path from "path"
import { uid } from "uid"
import type { Show, Slide, SlideData } from "../../../types/Show"
import type { SongbeamerMetadata } from "../../../shared/songbeamer/songbeamerCore"
import { applySongbeamerLayoutsToShow, convertSongbeamerFileToData, parseSongbeamerMetadata, stripSongbeamerBom } from "../../../shared/songbeamer/songbeamerCore"

const ITEM_STYLE = "top:88px;left:50px;height:904px;width:1820px;"

export type CtSngIndex = { byTitle: Map<string, string>; byCcli: Map<string, string> }

type CtGetFn = (domain: string, token: string, endpoint: string, params?: Record<string, string>) => Promise<any>

function buildSongShow(title: string, author: string, ccli: string, key: string, copyright: string, lyrics: string, category = "churchtools"): { showId: string; show: Show } {
    const slides: { [id: string]: Slide } = {}
    const layout: SlideData[] = []
    const lines = lyrics
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

    const id = uid()
    slides[id] = {
        group: title,
        globalGroup: title.toLowerCase(),
        color: null,
        settings: {},
        notes: "",
        items: [{ style: ITEM_STYLE, lines: (lines.length ? lines : [title]).map((line) => ({ align: "", text: [{ style: "", value: line }] })) }]
    }
    layout.push({ id })

    const layoutId = uid()
    const show: Show = {
        name: title,
        category,
        timestamps: { created: Date.now(), modified: null, used: null },
        meta: { title, author, CCLI: ccli, key, copyright },
        settings: { activeLayout: layoutId, template: null },
        layouts: { [layoutId]: { name: "Default", notes: "", slides: layout } },
        slides,
        media: {}
    }

    return { showId: `ctsong_${uid(8)}`, show }
}

export function buildHeaderShow(title: string, note: string, dateLabel: string): { showId: string; show: Show } {
    const qualifiedName = `${dateLabel} ${title}`
    const slideId = uid()
    const layoutId = uid()
    const show: Show = {
        name: qualifiedName,
        category: "churchtools",
        timestamps: { created: Date.now(), modified: null, used: null },
        meta: { title },
        settings: { activeLayout: layoutId, template: null },
        layouts: {
            [layoutId]: {
                name: "Default",
                notes: note,
                slides: [{ id: slideId }]
            }
        },
        slides: {
            [slideId]: {
                group: title,
                color: null,
                settings: { color: "#000000" },
                notes: note,
                items: []
            }
        },
        media: {}
    }
    return { showId: `ctheader_${uid(8)}`, show }
}

const WIN1252: Record<number, string> = {
    0x80: "\u20AC", 0x82: "\u201A", 0x83: "\u0192", 0x84: "\u201E", 0x85: "\u2026",
    0x86: "\u2020", 0x87: "\u2021", 0x88: "\u02C6", 0x89: "\u2030", 0x8A: "\u0160",
    0x8B: "\u2039", 0x8C: "\u0152", 0x8E: "\u017D", 0x91: "\u2018", 0x92: "\u2019",
    0x93: "\u201C", 0x94: "\u201D", 0x95: "\u2022", 0x96: "\u2013", 0x97: "\u2014",
    0x98: "\u02DC", 0x99: "\u2122", 0x9A: "\u0161", 0x9B: "\u203A", 0x9C: "\u0153",
    0x9E: "\u017E", 0x9F: "\u0178"
}

async function readSngFile(filePath: string): Promise<string> {
    const buf = await fs.promises.readFile(filePath)
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return stripSongbeamerBom(buf.slice(3).toString("utf-8"))
    const header = buf.slice(0, 512).toString("latin1")
    const enc = header.match(/^#Encoding=(.+)$/im)?.[1]?.trim().toLowerCase() ?? ""
    if (enc === "utf-8" || enc === "utf8") return stripSongbeamerBom(buf.toString("utf-8"))
    return stripSongbeamerBom(buf.toString("latin1").replace(/[\x80-\x9F]/g, (c) => WIN1252[c.charCodeAt(0)] ?? c))
}

export async function buildSngIndex(folderPath: string, onEmpty?: (message: string) => void): Promise<CtSngIndex> {
    const byTitle = new Map<string, string>()
    const byCcli = new Map<string, string>()

    async function scan(dir: string) {
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true })
            await Promise.all(entries.map(async (e) => {
                const full = path.join(dir, e.name)
                if (e.isDirectory()) { await scan(full); return }
                if (!e.isFile() || !e.name.toLowerCase().endsWith(".sng")) return
                try {
                    const raw = await readSngFile(full)
                    const { title, ccli } = parseSongbeamerMetadata(raw)
                    if (title) byTitle.set(title.toLowerCase().trim(), full)
                    if (ccli) byCcli.set(ccli.trim(), full)
                    const filenameNum = e.name.match(/^(\d+)\s/)
                    if (filenameNum) byCcli.set(filenameNum[1], full)
                    const filenameTitle = e.name.replace(/^\d+\s+/, "").replace(/\.sng$/i, "").trim()
                    if (filenameTitle) byTitle.set(filenameTitle.toLowerCase(), full)
                } catch {}
            }))
        } catch {}
    }

    try {
        await scan(folderPath)
    } catch (err: any) {
        console.warn("ChurchTools: cannot read SongBeamer folder:", err.message)
    }

    console.info(`ChurchTools: sng index built - ${byTitle.size} titles, ${byCcli.size} CCLIs from "${folderPath}"`)
    if (byTitle.size === 0 && folderPath && onEmpty) onEmpty(`ChurchTools: SongBeamer folder found 0 .sng files.\nCheck path: ${folderPath}`)
    return { byTitle, byCcli }
}

function stripTypePrefix(title: string): string {
    return title.replace(/^(?:song|lied|lob|worship|musik)\W+/i, "").trim()
}

function buildSongShowFromSng(
    title: string,
    author: string,
    ccli: string,
    key: string,
    copyright: string,
    raw: string,
    translationMethod: "multiline" | "textboxes" | "layouts",
    encoding: "utf8" | "latin1",
    category = "churchtools"
): { showId: string; show: Show } {
    const layoutId = uid()
    const { metadata, slides, layouts } = convertSongbeamerFileToData(title, raw, {
        translationMethod,
        itemStyle: ITEM_STYLE,
        encoding
    })

    const show: Show = {
        name: title,
        category,
        timestamps: { created: Date.now(), modified: null, used: null },
        meta: { title, author, CCLI: ccli, key, copyright },
        settings: { activeLayout: layoutId, template: null },
        layouts: { [layoutId]: { name: "Default", notes: "", slides: [] } },
        slides,
        media: {}
    }

    applySongbeamerLayoutsToShow(show, layoutId, { slides, layouts }, { baseNotes: metadata.comments })

    return { showId: `ctsong_${uid(8)}`, show }
}

function buildSongImportErrorLyrics(title: string, ccli: string, reason: string): string {
    const ccliLine = ccli ? `CCLI: ${ccli}` : "CCLI: unknown"
    return [
        "[Verse]",
        "SYNC ERROR: ChurchTools song could not be resolved to a local FreeShow song.",
        `Song: ${title}`,
        ccliLine,
        `Reason: ${reason}`,
        "Action: Import SongBeamer songs into FreeShow first, then right-click the related calendar event and choose 'Sync from CT'."
    ].join("\n")
}

async function lookupSng(sngIndex: CtSngIndex, title: string, ccli?: string): Promise<{ raw: string; sngMeta: SongbeamerMetadata } | null> {
    let sngPath = ccli ? sngIndex.byCcli.get(ccli.trim()) : undefined

    if (!sngPath && title) {
        const key = title.toLowerCase().trim()
        sngPath = sngIndex.byTitle.get(key)
        if (!sngPath) {
            const baseTitle = title.replace(/\s*[-\u2013]\s*.+$/, "").trim()
            if (baseTitle && baseTitle !== title) sngPath = sngIndex.byTitle.get(baseTitle.toLowerCase())
        }
        if (!sngPath && key.length > 4) {
            for (const [t, p] of sngIndex.byTitle.entries()) {
                if (t.includes(key) || key.includes(t)) {
                    sngPath = p
                    break
                }
            }
        }
    }

    if (!sngPath) {
        console.info(`ChurchTools lookupSng MISS: title="${title}" ccli="${ccli ?? ""}" byTitle.size=${sngIndex.byTitle.size} byCcli.size=${sngIndex.byCcli.size}`)
        return null
    }

    try {
        const raw = await readSngFile(sngPath)
        const sngMeta = parseSongbeamerMetadata(raw)
        console.info(`ChurchTools: .sng match for "${title}"${ccli ? ` (CCLI ${ccli})` : ""}`)
        return { raw, sngMeta }
    } catch {}

    return null
}

async function fetchSongMeta(domain: string, token: string, songId: number, ctGet: CtGetFn): Promise<{ title: string; author: string; ccli: string; key: string }> {
    const result = await ctGet(domain, token, `songs/${songId}`)
    const attr = result?.data?.attributes ?? {}
    const rawCcli = attr.ccliNo ?? attr.ccli ?? attr.ccliNumber ?? attr.ccliId ?? null
    console.info(`ChurchTools song ${songId}: name="${attr.name ?? attr.title}", ccliField keys=${Object.keys(attr).filter((k) => k.toLowerCase().includes("ccli")).join(",")}, ccli="${rawCcli}"`)
    return {
        title: attr.name ?? attr.title ?? "",
        author: attr.author ?? attr.composer ?? "",
        ccli: rawCcli != null && rawCcli !== "" ? String(rawCcli) : "",
        key: attr.key ?? attr.keyOfSong ?? ""
    }
}

export async function processAgendaItem(
    domain: string,
    token: string,
    item: any,
    ctGet: CtGetFn,
    sngIndex?: CtSngIndex,
    dateLabel = "",
    translationMethod: "multiline" | "textboxes" | "layouts" = "textboxes",
    sngEncoding: "utf8" | "latin1" = "utf8",
    sngCategory = "churchtools"
): Promise<{ showId: string; show: Show } | null> {
    const title = (item.title ?? item.name ?? "").trim()
    const note = (item.note ?? "").trim()

    const isSongLike = item.type === "song" || (item.type === "text" && /^(?:song|lied|lob|worship|musik)\W/i.test(title))
    if (isSongLike) {
        const songTitle = stripTypePrefix(title)
        const songObj = item.song ?? item.arrangement ?? item.songArrangement ?? null
        const linkedSongId: number | undefined = songObj?.id ?? songObj?.songId
        const embeddedTitle = (songObj?.title ?? songObj?.name ?? songObj?.song?.title ?? "").trim()
        const embeddedCcli = String(songObj?.ccliNo ?? songObj?.ccli ?? songObj?.song?.ccliNo ?? "")
        console.info(`ChurchTools: song item title="${title}" songObj=${JSON.stringify(songObj)?.slice(0, 200)}`)

        if (linkedSongId) {
            const meta = await fetchSongMeta(domain, token, linkedSongId, ctGet)
            const resolvedTitle = meta.title || embeddedTitle || songTitle || "Song"
            const resolvedCcli = meta.ccli || embeddedCcli

            if (sngIndex) {
                const localMatch = await lookupSng(sngIndex, resolvedTitle, resolvedCcli)
                if (localMatch) {
                    const sngTitle = localMatch.sngMeta.title || resolvedTitle
                    const sngAuthor = localMatch.sngMeta.author || meta.author || ""
                    const sngCcli = localMatch.sngMeta.ccli || resolvedCcli
                    const sngKey = localMatch.sngMeta.key || meta.key || ""
                    const sngCopyright = localMatch.sngMeta.copyright || ""
                    return buildSongShowFromSng(sngTitle, sngAuthor, sngCcli, sngKey, sngCopyright, localMatch.raw, translationMethod, sngEncoding, sngCategory)
                }
            }

            const errorLyrics = buildSongImportErrorLyrics(resolvedTitle, resolvedCcli, "No matching local migrated song found")
            return buildSongShow(resolvedTitle, meta.author || "", resolvedCcli, meta.key || "", "", errorLyrics, sngCategory)
        }

        if (songTitle) {
            if (sngIndex) {
                const localMatch = await lookupSng(sngIndex, songTitle)
                if (localMatch) {
                    const sngTitle = localMatch.sngMeta.title || songTitle
                    const sngAuthor = localMatch.sngMeta.author || ""
                    const sngCcli = localMatch.sngMeta.ccli || ""
                    const sngKey = localMatch.sngMeta.key || ""
                    const sngCopyright = localMatch.sngMeta.copyright || ""
                    return buildSongShowFromSng(sngTitle, sngAuthor, sngCcli, sngKey, sngCopyright, localMatch.raw, translationMethod, sngEncoding, sngCategory)
                }
            }
            const errorLyrics = buildSongImportErrorLyrics(songTitle, "", "ChurchTools item is not linked to a ChurchTools song")
            return buildSongShow(songTitle, "", "", "", "", errorLyrics, sngCategory)
        }
    }

    if (!title) return null
    return buildHeaderShow(title, note, dateLabel)
}
