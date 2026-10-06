import fs from "fs"
import path from "path"
import { uid } from "uid"
import type { Show, Slide, SlideData } from "../../../types/Show"

const ITEM_STYLE = "left:50px;top:120px;width:1820px;height:840px;"
const ITEM_STYLE_TOP = "left:50px;top:80px;width:1820px;height:430px;"
const ITEM_STYLE_BOTTOM = "left:50px;top:530px;width:1820px;height:430px;"

const SNG_SECTION_RE = /(?:^|\n)--(?:-|A)?\s*\n/

const SONGBEAMER_GROUPS: Record<string, string> = {
    unbekannt: "", unbenannt: "", unknown: "",
    intro: "Intro",
    vers: "Verse", verse: "Verse", strophe: "Verse",
    "pre-bridge": "Pre-Bridge", bridge: "Bridge",
    misc: "Misc",
    "pre-refrain": "Pre-Chorus", refrain: "Chorus",
    "pre-chorus": "Pre-Chorus", chorus: "Chorus",
    zwischenspiel: "Break", instrumental: "Break", interlude: "Break",
    "pre-coda": "Pre-Outro", coda: "Outro", ending: "Outro", outro: "Outro",
    teil: "Tag", part: "Tag", chor: "Tag", solo: "Tag"
}

export type CtSngIndex = { byTitle: Map<string, string>; byCcli: Map<string, string> }

type CtGetFn = (domain: string, token: string, endpoint: string, params?: Record<string, string>) => Promise<any>

function sngSlideTagToGroup(line: string): { group: string | null; groupNumber: number | null } {
    if (line.charAt(0) === "#") return { group: null, groupNumber: null }
    const parts = line.split(" ", 2)
    const tag = parts[0].toLowerCase()
    let groupNumber: number | null = parseInt(parts[1], 10)
    if (parts.length < 2 || isNaN(groupNumber) || groupNumber < 1) groupNumber = null
    return { group: SONGBEAMER_GROUPS[tag] ?? null, groupNumber }
}

function parseSngMeta(text: string): { title: string; author: string; composer: string; ccli: string; key: string; copyright: string } {
    const meta = { title: "", author: "", composer: "", ccli: "", key: "", copyright: "" }
    const headerSection = text.split(SNG_SECTION_RE)[0]
    for (const line of headerSection.split("\n")) {
        if (!line || line[0] !== "#") continue
        const eq = line.indexOf("=")
        if (eq < 2) continue
        const val = line.slice(eq + 1).trim()
        switch (line.slice(1, eq)) {
            case "Title":
                meta.title = val
                break
            case "Author":
                meta.author = val
                break
            case "Melody":
                meta.composer = val
                break
            case "Key":
                meta.key = val
                break
            case "(c)":
                meta.copyright = val
                break
            case "CCLI": {
                let i = 0
                while (i < val.length && val[i] >= "0" && val[i] <= "9") i++
                meta.ccli = val.slice(0, i)
                break
            }
        }
    }
    return meta
}

function parseLyrics(text: string): { label: string; lines: string[] }[] {
    if (!text?.trim()) return []

    const sections: { label: string; lines: string[] }[] = []
    let label = "Verse"
    let block: string[] = []
    let labelUsed = false

    function flush() {
        const content = block.map((l) => l.trim()).filter(Boolean)
        if (!content.length) return
        sections.push({ label: labelUsed ? `${label} ${sections.filter((s) => s.label.startsWith(label)).length + 1}` : label, lines: content })
        labelUsed = true
        block = []
    }

    const chordLineRe = /^([A-G][b#]?(?:m|maj|min|sus|add|aug|dim|7|9|11|13)?\d*(?:\/[A-G][b#]?)?\s*){2,}$/i

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim()
        if (/^-{2,}$/.test(line)) continue
        if (chordLineRe.test(line)) continue

        const sectionMatch = line.match(/^\[(.+)\]$/)
        if (sectionMatch) {
            flush()
            label = sectionMatch[1].trim()
            labelUsed = false
            continue
        }

        if (!line) {
            flush()
            continue
        }

        block.push(line)
    }
    flush()

    return sections
}

function buildSongShow(title: string, author: string, ccli: string, key: string, copyright: string, lyrics: string): { showId: string; show: Show } {
    const sections = parseLyrics(lyrics)
    const slides: { [id: string]: Slide } = {}
    const layout: SlideData[] = []

    if (!sections.length) {
        const id = uid()
        slides[id] = { group: title, color: null, settings: {}, notes: "", items: [{ style: ITEM_STYLE, lines: [{ align: "text-align:center;", text: [{ style: "font-size:80px;font-weight:bold;", value: title }] }] }] }
        layout.push({ id })
    } else {
        sections.forEach(({ label, lines }) => {
            const id = uid()
            slides[id] = {
                group: label,
                globalGroup: label.toLowerCase().replace(/\s+\d+$/, "").trim(),
                color: null,
                settings: {},
                notes: "",
                items: [{ style: ITEM_STYLE, lines: lines.map((l) => ({ align: "", text: [{ style: "", value: l }] })) }]
            }
            layout.push({ id })
        })
    }

    const layoutId = uid()
    const show: Show = {
        name: title,
        category: "churchtools",
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
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString("utf-8")
    const header = buf.slice(0, 512).toString("latin1")
    const enc = header.match(/^#Encoding=(.+)$/im)?.[1]?.trim().toLowerCase() ?? ""
    if (enc === "utf-8" || enc === "utf8") return buf.toString("utf-8")
    return buf.toString("latin1").replace(/[\x80-\x9F]/g, (c) => WIN1252[c.charCodeAt(0)] ?? c)
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
                    const { title, ccli } = parseSngMeta(raw)
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

function sngToLyricsText(raw: string): string {
    const sections = raw.split(SNG_SECTION_RE).slice(1)
    return sections
        .map((section) => {
            const lines = section.split("\n").map((l) => l.trim()).filter(Boolean)
            if (!lines.length) return ""
            const { group, groupNumber } = sngSlideTagToGroup(lines[0])
            if (group !== null) {
                const label = groupNumber ? `${group} ${groupNumber}` : group
                return `[${label}]\n${lines.slice(1).join("\n")}`
            }
            return lines.join("\n")
        })
        .filter(Boolean)
        .join("\n\n")
}

function getSngLangCount(raw: string): number {
    const header = raw.split(SNG_SECTION_RE)[0]
    const m = /^#LangCount=(\d+)/m.exec(header)
    const n = m ? parseInt(m[1], 10) : 1
    return isNaN(n) || n < 1 ? 1 : n
}

function sngToBilingualSections(raw: string, langCount: number): { label: string; langLines: string[][] }[] {
    const markerRe = /^#([A-Za-z]+)\s+/
    const langOverwriteRe = /^(#)?#(\d)\s+/
    return raw.split(SNG_SECTION_RE).slice(1).flatMap((section) => {
        const rawLines = section.split("\n")
        let label = ""
        let startIdx = 0
        const first = rawLines[0]?.trim() ?? ""
        if (first) {
            const { group, groupNumber } = sngSlideTagToGroup(first)
            if (group !== null) { label = groupNumber ? `${group} ${groupNumber}` : group; startIdx = 1 }
        }
        const langLines: string[][] = Array.from({ length: langCount }, () => [])
        let lang = 0
        for (let i = startIdx; i < rawLines.length; i++) {
            let line = rawLines[i].trim()
            if (!line) continue
            const marker = markerRe.exec(line)
            if (marker) {
                if (marker[1].toUpperCase() === "H") { lang++; continue }
                line = line.substring(marker[0].length)
            }
            const langMatch = langOverwriteRe.exec(line)
            if (langMatch) {
                const idx = parseInt(langMatch[2], 10) - 1
                const noInc = !!langMatch[1]
                const text = line.substring(langMatch[0].length).trim()
                if (idx >= 0 && idx < langCount && text) langLines[idx].push(text)
                if (!noInc) lang++
                continue
            }
            if (lang >= langCount) lang = 0
            langLines[lang].push(line)
            lang++
        }
        return langLines.some((l) => l.length > 0) ? [{ label, langLines }] : []
    })
}

function buildBilingualSongShow(title: string, author: string, ccli: string, key: string, copyright: string, raw: string, langCount: number): { showId: string; show: Show } {
    const sections = sngToBilingualSections(raw, langCount)
    if (!sections.length) return buildSongShow(title, author, ccli, key, copyright, sngToLyricsText(raw))

    const slides: { [id: string]: Slide } = {}
    const layout: SlideData[] = []
    const labelCounts: Record<string, number> = {}

    for (const { label, langLines } of sections) {
        const base = label || "Verse"
        labelCounts[base] = (labelCounts[base] ?? 0) + 1
        const group = labelCounts[base] > 1 ? `${base} ${labelCounts[base]}` : base
        const id = uid()
        slides[id] = {
            group,
            globalGroup: group.toLowerCase().replace(/\s+\d+$/, "").trim(),
            color: null,
            settings: {},
            notes: "",
            items: langLines.map((lines, i) => ({
                style: i === 0 ? ITEM_STYLE_TOP : ITEM_STYLE_BOTTOM,
                lines: (lines.length ? lines : [""]).map((l) => ({ align: "", text: [{ style: "", value: l }] }))
            }))
        }
        layout.push({ id })
    }

    const layoutId = uid()
    const show: Show = {
        name: title,
        category: "churchtools",
        timestamps: { created: Date.now(), modified: null, used: null },
        meta: { title, author, CCLI: ccli, key, copyright },
        settings: { activeLayout: layoutId, template: null },
        layouts: { [layoutId]: { name: "Default", notes: "", slides: layout } },
        slides,
        media: {}
    }
    return { showId: `ctsong_${uid(8)}`, show }
}

function stripTypePrefix(title: string): string {
    return title.replace(/^(?:song|lied|lob|worship|musik)\W+/i, "").trim()
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

async function lookupSng(sngIndex: CtSngIndex, title: string, ccli?: string): Promise<{ lyrics: string; raw: string; langCount: number; sngMeta: ReturnType<typeof parseSngMeta> } | null> {
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
                if (t.includes(key) || key.includes(t)) { sngPath = p; break }
            }
        }
    }

    if (!sngPath) {
        console.info(`ChurchTools lookupSng MISS: title="${title}" ccli="${ccli ?? ""}" byTitle.size=${sngIndex.byTitle.size} byCcli.size=${sngIndex.byCcli.size}`)
        return null
    }
    try {
        const raw = await readSngFile(sngPath)
        const lyrics = sngToLyricsText(raw)
        if (lyrics.trim()) {
            console.info(`ChurchTools: .sng match for "${title}"${ccli ? ` (CCLI ${ccli})` : ""}`)
            const langCount = getSngLangCount(raw)
            const sngMeta = parseSngMeta(raw)
            return { lyrics, raw, langCount, sngMeta }
        }
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
    translationMethod: "multiline" | "textboxes" = "textboxes"
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
                    if (translationMethod === "textboxes" && localMatch.langCount > 1) {
                        return buildBilingualSongShow(sngTitle, sngAuthor, sngCcli, sngKey, sngCopyright, localMatch.raw, localMatch.langCount)
                    }
                    return buildSongShow(sngTitle, sngAuthor, sngCcli, sngKey, sngCopyright, localMatch.lyrics)
                }
            }

            const errorLyrics = buildSongImportErrorLyrics(resolvedTitle, resolvedCcli, "No matching local migrated song found")
            return buildSongShow(resolvedTitle, meta.author || "", resolvedCcli, meta.key || "", "", errorLyrics)
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
                    if (translationMethod === "textboxes" && localMatch.langCount > 1) {
                        return buildBilingualSongShow(sngTitle, sngAuthor, sngCcli, sngKey, sngCopyright, localMatch.raw, localMatch.langCount)
                    }
                    return buildSongShow(sngTitle, sngAuthor, sngCcli, sngKey, sngCopyright, localMatch.lyrics)
                }
            }
            const errorLyrics = buildSongImportErrorLyrics(songTitle, "", "ChurchTools item is not linked to a ChurchTools song")
            return buildSongShow(songTitle, "", "", "", "", errorLyrics)
        }
    }

    if (!title) return null
    return buildHeaderShow(title, note, dateLabel)
}
