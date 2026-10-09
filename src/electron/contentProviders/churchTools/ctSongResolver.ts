import fs from "fs"
import path from "path"
import { uid } from "uid"
import type { Item, Layout, Show, Slide, SlideData } from "../../../types/Show"
import type { SongbeamerMetadata } from "../../../shared/songbeamer/songbeamerCore"
import { applySongbeamerLayoutsToShow, convertSongbeamerFileToData, parseSongbeamerMetadata, stripSongbeamerBom } from "../../../shared/songbeamer/songbeamerCore"

const ITEM_STYLE = "top:88px;left:50px;height:904px;width:1820px;"

export type CtSngIndex = { byTitle: Map<string, string>; byCcli: Map<string, string> }

type CtGetFn = (domain: string, token: string, endpoint: string, params?: Record<string, string>) => Promise<any>
type SngVariationFamily = "multiline" | "textboxes" | "single"
type SongbeamerConversion = ReturnType<typeof convertSongbeamerFileToData>
type BilingualVariantMode = "ml_balanced" | "ml_emphasis" | "tb_balanced" | "tb_emphasis"

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

function normalizeVariationFamilies(families?: SngVariationFamily[]): SngVariationFamily[] {
    if (!Array.isArray(families) || !families.length) return []

    const validFamilies: SngVariationFamily[] = ["multiline", "textboxes", "single"]
    const normalized = families.filter((value): value is SngVariationFamily => validFamilies.includes(value as SngVariationFamily))
    return Array.from(new Set(normalized))
}

function normalizeSongbeamerEncoding(rawText: string, encoding: "auto" | "utf8" | "latin1"): "utf8" | "latin1" {
    if (encoding === "utf8" || encoding === "latin1") return encoding

    const declared = rawText.match(/^#Encoding=(.+)$/im)?.[1]?.trim().toLowerCase() || ""
    if (["latin1", "iso-8859-1", "cp1252", "windows-1252", "ansi"].includes(declared)) return "latin1"
    return "utf8"
}

function getBilingualLanguageLabels(rawText: string, langCount: number): [string, string] {
    const fallback: [string, string] = ["EN", "DE"]
    if (!rawText || langCount < 2) return fallback

    const languageCodes = extractLanguageCodesFromMetadata(rawText, langCount)
    const first = languageCodes[0] || fallback[0]
    const second = languageCodes[1] || fallback[1]
    return [first, second]
}

function extractLanguageCodesFromMetadata(rawText: string, langCount: number): string[] {
    const codes: string[] = Array.from({ length: Math.max(2, langCount) }, () => "")

    for (const line of rawText.split(/\r?\n/)) {
        if (!line.startsWith("#")) continue

        const parts = line.substring(1).split("=", 2)
        if (parts.length !== 2) continue

        const key = parts[0].trim().toLowerCase()
        if (key === "langcount") continue

        const value = parts[1].trim()
        if (!value) continue

        const indexMatch = key.match(/(?:^|[^a-z])(lang|language)(?:code|name)?\s*(\d+)(?:$|[^a-z])/i)
        if (!indexMatch) continue

        const index = parseInt(indexMatch[2], 10) - 1
        if (isNaN(index) || index < 0 || index >= codes.length || codes[index]) continue

        const normalized = normalizeLanguageCode(value)
        if (normalized) codes[index] = normalized
    }

    return codes
}

function normalizeLanguageCode(raw: string): string {
    const cleaned = raw.trim().toLowerCase()
    if (!cleaned) return ""

    const namedMap: { [key: string]: string } = {
        english: "EN",
        deutsch: "DE",
        german: "DE",
        francais: "FR",
        french: "FR",
        espanol: "ES",
        spanish: "ES",
        italiano: "IT",
        italian: "IT",
        portugues: "PT",
        portuguese: "PT",
        nederlands: "NL",
        dutch: "NL"
    }

    if (namedMap[cleaned]) return namedMap[cleaned]

    const token = cleaned.split(/[\s,;|/_-]+/).find(Boolean) || ""
    if (!token) return ""

    if (/^[a-z]{2}$/.test(token)) return token.toUpperCase()
    if (/^[a-z]{2,3}$/.test(token)) return token.slice(0, 2).toUpperCase()

    return ""
}

function buildBilingualVariants(raw: string, encoding: "utf8" | "latin1", families: SngVariationFamily[]): SongbeamerConversion {
    const mergedSlides: { [key: string]: Slide } = {}
    const layouts: Layout[] = []

    const baseMetadata = parseSongbeamerMetadata(raw, encoding)
    const [firstLang, secondLang] = getBilingualLanguageLabels(raw, baseMetadata.lang_count)
    const firstUpper = firstLang.toUpperCase()
    const secondUpper = secondLang.toUpperCase()
    const firstLower = firstLang.toLowerCase()
    const secondLower = secondLang.toLowerCase()

    if (families.includes("multiline")) {
        const conversion = convertSongbeamerFileToData("", raw, { translationMethod: "multiline", itemStyle: ITEM_STYLE, encoding })
        Object.assign(mergedSlides, conversion.slides)

        const baseLayout = conversion.layouts[0]
        if (baseLayout) {
            layouts.push({ id: uid(), name: `${firstUpper}/${secondLower}`, notes: "", slides: cloneLayoutSlidesForVariant(baseLayout.slides, mergedSlides, "ml_balanced") })
            layouts.push({ id: uid(), name: `${firstUpper}+${secondLower}`, notes: "", slides: cloneLayoutSlidesForVariant(baseLayout.slides, mergedSlides, "ml_emphasis") })
        }
    }

    if (families.includes("textboxes")) {
        const conversion = convertSongbeamerFileToData("", raw, { translationMethod: "textboxes", itemStyle: ITEM_STYLE, encoding })
        Object.assign(mergedSlides, conversion.slides)

        const baseLayout = conversion.layouts[0]
        if (baseLayout) {
            layouts.push({ id: uid(), name: `${firstLower}/${secondUpper}`, notes: "", slides: cloneLayoutSlidesForVariant(baseLayout.slides, mergedSlides, "tb_balanced") })
            layouts.push({ id: uid(), name: `${firstLower}+${secondUpper}`, notes: "", slides: cloneLayoutSlidesForVariant(baseLayout.slides, mergedSlides, "tb_emphasis") })
        }
    }

    if (families.includes("single")) {
        const conversion = convertSongbeamerFileToData("", raw, { translationMethod: "layouts", itemStyle: ITEM_STYLE, encoding })
        Object.assign(mergedSlides, conversion.slides)

        const primaryLayout = conversion.layouts[0]
        const secondaryLayout = conversion.layouts[1]
        if (primaryLayout) layouts.push({ ...primaryLayout, id: uid(), name: firstUpper })
        if (secondaryLayout) layouts.push({ ...secondaryLayout, id: uid(), name: secondUpper })
    }

    return { metadata: baseMetadata, slides: mergedSlides, layouts }
}

function cloneLayoutSlidesForVariant(sourceSlides: SlideData[], allSlides: { [key: string]: Slide }, mode: BilingualVariantMode): SlideData[] {
    const slideIdMap: { [key: string]: string } = {}
    const visited = new Set<string>()

    const markSlideTree = (slideId: string) => {
        if (!slideId || visited.has(slideId) || !allSlides[slideId]) return
        visited.add(slideId)

        const slide = allSlides[slideId]
        slide.children?.forEach((childId) => markSlideTree(childId))
    }

    sourceSlides.forEach(({ id }) => markSlideTree(id))
    visited.forEach((oldId) => {
        slideIdMap[oldId] = uid()
    })

    visited.forEach((oldId) => {
        const sourceSlide = allSlides[oldId]
        if (!sourceSlide) return

        const clonedSlide = cloneDeep(sourceSlide)
        if (Array.isArray(clonedSlide.children)) {
            clonedSlide.children = clonedSlide.children.map((childId) => slideIdMap[childId]).filter(Boolean)
        }
        clonedSlide.items = createVariantItems(clonedSlide.items, mode)

        allSlides[slideIdMap[oldId]] = clonedSlide
    })

    return sourceSlides.map((slideData) => remapSlideData(slideData, slideIdMap))
}

function remapSlideData(slideData: SlideData, slideIdMap: { [key: string]: string }): SlideData {
    const cloned = cloneDeep(slideData)
    if (slideIdMap[cloned.id]) cloned.id = slideIdMap[cloned.id]
    if (cloned.children) cloned.children = remapChildrenMap(cloned.children, slideIdMap)
    return cloned
}

function remapChildrenMap(children: { [key: string]: any }, slideIdMap: { [key: string]: string }): { [key: string]: any } {
    const remappedChildren: { [key: string]: any } = {}
    Object.entries(children).forEach(([key, value]) => {
        const newKey = slideIdMap[key] || key
        remappedChildren[newKey] = remapChildValue(value, slideIdMap)
    })
    return remappedChildren
}

function remapChildValue(value: any, slideIdMap: { [key: string]: string }) {
    if (!value || typeof value !== "object") return value

    const cloned = cloneDeep(value)
    if (typeof cloned.id === "string" && slideIdMap[cloned.id]) cloned.id = slideIdMap[cloned.id]
    if (cloned.children && typeof cloned.children === "object") {
        cloned.children = remapChildrenMap(cloned.children, slideIdMap)
    }
    return cloned
}

function createVariantItems(items: Item[], mode: BilingualVariantMode): Item[] {
    if (!Array.isArray(items) || !items.length) return []

    if (mode === "ml_balanced") {
        const multiline = cloneDeep(items[0])
        return [styleMultiline(multiline, false)]
    }
    if (mode === "ml_emphasis") {
        const multiline = cloneDeep(items[0])
        return [styleMultiline(multiline, true)]
    }

    const firstLanguage = cloneDeep(items[0] || items[items.length - 1])
    const secondLanguage = cloneDeep(items[1] || items[0] || items[items.length - 1])

    if (mode === "tb_balanced") return [styleTextboxPrimary(secondLanguage, false), styleTextboxSecondary(firstLanguage, false)]
    return [styleTextboxPrimary(secondLanguage, true), styleTextboxSecondary(firstLanguage, true)]
}

function styleMultiline(item: Item, emphasis: boolean): Item {
    item.style = setStyleValue(item.style || "", "font-weight", emphasis ? "700" : "500")
    item.style = setStyleValue(item.style, "font-style", "normal")
    item.style = setStyleValue(item.style, "font-size", emphasis ? "1.08em" : "1.0em")
    return item
}

function styleTextboxPrimary(item: Item, emphasis: boolean): Item {
    item.style = setStyleValue(item.style || "", "font-weight", emphasis ? "700" : "600")
    item.style = setStyleValue(item.style, "font-style", "normal")
    item.style = setStyleValue(item.style, "font-size", emphasis ? "1.08em" : "1em")

    if (emphasis) {
        const { top, height } = getStyleTopHeight(item.style)
        if (top !== null && height !== null) {
            item.style = setStyleValue(item.style, "top", `${Math.round(top)}px`)
            item.style = setStyleValue(item.style, "height", `${Math.max(120, Math.round(height * 0.62))}px`)
        } else {
            item.style = setStyleValue(item.style, "top", "15%")
            item.style = setStyleValue(item.style, "height", "56%")
        }
    }

    return item
}

function styleTextboxSecondary(item: Item, emphasis: boolean): Item {
    item.style = setStyleValue(item.style || "", "font-weight", emphasis ? "400" : "500")
    item.style = setStyleValue(item.style, "font-style", emphasis ? "italic" : "normal")
    item.style = setStyleValue(item.style, "font-size", emphasis ? "0.78em" : "0.92em")
    if (emphasis) item.style = setStyleValue(item.style, "opacity", "0.9")

    const { top, height } = getStyleTopHeight(item.style)
    if (top !== null && height !== null) {
        const baseTopFactor = emphasis ? 0.66 : 0.58
        const baseHeightFactor = emphasis ? 0.28 : 0.38
        const smallTop = Math.round(top + height * baseTopFactor)
        const smallHeight = Math.max(80, Math.round(height * baseHeightFactor))
        item.style = setStyleValue(item.style, "top", `${smallTop}px`)
        item.style = setStyleValue(item.style, "height", `${smallHeight}px`)
    } else {
        item.style = setStyleValue(item.style, "top", emphasis ? "73%" : "65%")
        item.style = setStyleValue(item.style, "height", emphasis ? "22%" : "30%")
    }

    return item
}

function getStyleTopHeight(style: string): { top: number | null; height: number | null } {
    const topMatch = style.match(/(?:^|;)\s*top\s*:\s*(-?\d+(?:\.\d+)?)px\s*(?:;|$)/i)
    const heightMatch = style.match(/(?:^|;)\s*height\s*:\s*(-?\d+(?:\.\d+)?)px\s*(?:;|$)/i)

    return {
        top: topMatch ? parseFloat(topMatch[1]) : null,
        height: heightMatch ? parseFloat(heightMatch[1]) : null
    }
}

function setStyleValue(style: string, key: string, value: string): string {
    const normalized = style.replace(new RegExp(`(?:^|;)\\s*${escapeRegExp(key)}\\s*:[^;]*;?`, "gi"), ";")
    const withSeparator = normalized.trim().endsWith(";") || normalized.trim() === "" ? normalized.trim() : `${normalized.trim()};`
    return `${withSeparator}${key}:${value};`
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function cloneDeep<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
}

function buildSongShowFromSng(
    title: string,
    author: string,
    ccli: string,
    key: string,
    copyright: string,
    raw: string,
    translationMethod: "multiline" | "textboxes" | "layouts",
    encoding: "auto" | "utf8" | "latin1",
    category = "churchtools",
    variationFamilies?: SngVariationFamily[]
): { showId: string; show: Show } {
    const layoutId = uid()
    const resolvedEncoding = normalizeSongbeamerEncoding(raw, encoding)
    let conversion = convertSongbeamerFileToData(title, raw, {
        translationMethod,
        itemStyle: ITEM_STYLE,
        encoding: resolvedEncoding
    })

    const normalizedFamilies = normalizeVariationFamilies(variationFamilies)
    if (conversion.metadata.lang_count >= 2 && normalizedFamilies.length) {
        const variantConversion = buildBilingualVariants(raw, resolvedEncoding, normalizedFamilies)
        if (variantConversion.layouts.length) {
            variantConversion.metadata = conversion.metadata
            conversion = variantConversion
        }
    }

    const { metadata, slides, layouts } = conversion

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
    sngEncoding: "auto" | "utf8" | "latin1" = "auto",
    sngCategory = "churchtools",
    variationFamilies?: SngVariationFamily[]
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
                    return buildSongShowFromSng(sngTitle, sngAuthor, sngCcli, sngKey, sngCopyright, localMatch.raw, translationMethod, sngEncoding, sngCategory, variationFamilies)
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
                    return buildSongShowFromSng(sngTitle, sngAuthor, sngCcli, sngKey, sngCopyright, localMatch.raw, translationMethod, sngEncoding, sngCategory, variationFamilies)
                }
            }
            const errorLyrics = buildSongImportErrorLyrics(songTitle, "", "ChurchTools item is not linked to a ChurchTools song")
            return buildSongShow(songTitle, "", "", "", "", errorLyrics, sngCategory)
        }
    }

    if (!title) return null
    return buildHeaderShow(title, note, dateLabel)
}
