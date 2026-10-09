import { get } from "svelte/store"
import { uid } from "uid"
import type { Item, Show, Slide, SlideData } from "../../types/Show"
import { TranslationMethod } from "../../types/Songbeamer"
import { applySongbeamerLayoutsToShow, convertSongbeamerFileToData, toSongbeamerTranslationMethod } from "../../shared/songbeamer/songbeamerCore"
import { ShowObj } from "../classes/Show"
import { history } from "../components/helpers/history"
import { setQuickAccessMetadata } from "../components/helpers/setShow"
import { checkName, getGlobalGroup } from "../components/helpers/show"
import { categories, globalTags } from "../stores"
import { createCategory, setTempShows } from "./importHelpers"
import { DEFAULT_ITEM_STYLE } from "../components/edit/scripts/itemHelpers"

interface ImportSettings {
    category: string
    encoding: BufferEncoding
    translationMethod: TranslationMethod
    bilingualVariations: boolean
}

type SongbeamerImportFile = { name: string; content: string; encoding?: BufferEncoding }

type SongbeamerConversion = ReturnType<typeof convertSongbeamerFileToData>

type BilingualVariant = "en_de" | "de_en" | "en_only" | "de_only"

export function convertSongbeamerFiles({ files = [], category = "Songbeamer", translationMethod = TranslationMethod.MultiLine, encoding = "utf8", bilingualVariations = true }: any) {
    const settings: ImportSettings = {
        category,
        encoding: normalizeSongbeamerEncoding(encoding),
        translationMethod,
        bilingualVariations
    }

    const tempShows: { id: string; show: Show }[] = (files as SongbeamerImportFile[]).map((file) => {
        const show = convertSongbeamerFileToShow(file.name, file.content, {
            ...settings,
            encoding: normalizeSongbeamerEncoding(file.encoding)
        })
        return { id: uid(), show }
    })

    setTempShows(tempShows)
}

function normalizeSongbeamerEncoding(encoding: BufferEncoding | "auto" | string | undefined): BufferEncoding {
    if (encoding === "latin1") return "latin1"
    return "utf8"
}

function convertSongbeamerFileToShow(name: string, text: string, settings: ImportSettings) {
    let categoryId: string | null = null
    if (get(categories)[settings.category]) {
        categoryId = settings.category
    } else if (settings.category === "songbeamer") {
        categoryId = createCategory("Songbeamer")
    }

    const layoutId = uid()
    let show = new ShowObj(false, categoryId, layoutId)
    show.origin = "songbeamer"

    let conversion = convertSongbeamerFileToData(name, text, {
        translationMethod: toSongbeamerTranslationMethod(settings.translationMethod),
        itemStyle: DEFAULT_ITEM_STYLE,
        encoding: settings.encoding,
        resolveGlobalGroup: (group: string): string => getGlobalGroup(group)
    })

    if (settings.bilingualVariations && conversion.metadata.lang_count >= 2) {
        // Always build bilingual presets from textbox slides so each language can be styled independently.
        conversion = convertSongbeamerFileToData(name, text, {
            translationMethod: TranslationMethod.Textboxes,
            itemStyle: DEFAULT_ITEM_STYLE,
            encoding: settings.encoding,
            resolveGlobalGroup: (group: string): string => getGlobalGroup(group)
        })
        addBilingualLayoutVariations(conversion, text)
    }

    const { metadata, slides, layouts } = conversion

    show.name = checkName(metadata.title)
    show.meta = {
        number: metadata.number,
        title: metadata.title,
        author: metadata.author,
        composer: metadata.composer,
        publisher: metadata.publisher,
        copyright: metadata.copyright,
        CCLI: metadata.ccli
    }
    if (show.meta.number !== undefined) show.quickAccess = { number: show.meta.number }
    if (show.meta.CCLI) show = setQuickAccessMetadata(show, "CCLI", show.meta.CCLI)

    // add tags
    const tags = getTags(metadata.keywords.split(","))
    if (tags.length) {
        if (!show.quickAccess) show.quickAccess = {}
        show.quickAccess.tags = tags
    }

    applySongbeamerLayoutsToShow(show as Show, layoutId, { slides, layouts }, { baseNotes: metadata.comments })

    return show as Show
}

function addBilingualLayoutVariations(conversion: SongbeamerConversion, rawText: string) {
    const sourceLayout = conversion.layouts[0]
    if (!sourceLayout?.slides?.length) return

    const [firstLang, secondLang] = getBilingualLanguageLabels(rawText, conversion.metadata.lang_count)
    const firstUpper = firstLang.toUpperCase()
    const secondUpper = secondLang.toUpperCase()
    const firstLower = firstLang.toLowerCase()
    const secondLower = secondLang.toLowerCase()

    const variants: { name: string; mode: BilingualVariant }[] = [
        { name: `${firstUpper}+${secondLower}`, mode: "en_de" },
        { name: `${firstLower}+${secondUpper}`, mode: "de_en" },
        { name: firstUpper, mode: "en_only" },
        { name: secondUpper, mode: "de_only" }
    ]

    const variantLayouts = variants.map(({ name, mode }) => ({
        id: uid(),
        name,
        notes: "",
        slides: cloneLayoutSlidesForVariant(sourceLayout.slides, conversion.slides, mode)
    }))

    conversion.layouts = variantLayouts
}

function cloneLayoutSlidesForVariant(sourceSlides: SlideData[], allSlides: { [key: string]: Slide }, mode: BilingualVariant): SlideData[] {
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

function createVariantItems(items: Item[], mode: BilingualVariant): Item[] {
    if (!Array.isArray(items) || !items.length) return []

    const firstLanguage = cloneDeep(items[0] || items[items.length - 1])
    const secondLanguage = cloneDeep(items[1] || items[0] || items[items.length - 1])

    if (mode === "en_only") return [styleLargePrimary(firstLanguage)]
    if (mode === "de_only") return [styleLargePrimary(secondLanguage)]
    if (mode === "de_en") return [styleLargePrimary(secondLanguage, true), styleSmallSecondary(firstLanguage)]
    return [styleLargePrimary(firstLanguage, true), styleSmallSecondary(secondLanguage)]
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
        if (normalized) {
            codes[index] = normalized
        }
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
        dutch: "NL",
        svenska: "SV",
        swedish: "SV",
        norsk: "NO",
        norwegian: "NO"
    }

    if (namedMap[cleaned]) return namedMap[cleaned]

    const token = cleaned.split(/[\s,;|/_-]+/).find(Boolean) || ""
    if (!token) return ""

    if (/^[a-z]{2}$/.test(token)) return token.toUpperCase()
    if (/^[a-z]{2,3}$/.test(token)) return token.slice(0, 2).toUpperCase()

    return ""
}

function styleLargePrimary(item: Item, splitView = false): Item {
    item.style = setStyleValue(item.style || "", "font-weight", "700")
    item.style = setStyleValue(item.style, "font-style", "normal")
    item.style = setStyleValue(item.style, "font-size", splitView ? "1.08em" : "1.15em")

    if (splitView) {
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

function styleSmallSecondary(item: Item): Item {
    item.style = setStyleValue(item.style || "", "font-weight", "400")
    item.style = setStyleValue(item.style, "font-style", "italic")
    item.style = setStyleValue(item.style, "font-size", "0.78em")
    item.style = setStyleValue(item.style, "opacity", "0.9")

    const { top, height } = getStyleTopHeight(item.style)
    if (top !== null && height !== null) {
        const smallTop = Math.round(top + height * 0.66)
        const smallHeight = Math.max(80, Math.round(height * 0.28))
        item.style = setStyleValue(item.style, "top", `${smallTop}px`)
        item.style = setStyleValue(item.style, "height", `${smallHeight}px`)
    } else {
        item.style = setStyleValue(item.style, "top", "73%")
        item.style = setStyleValue(item.style, "height", "22%")
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

function getTags(tags: string[]) {
    return tags.map((tag) => getOrCreateTag(tag.trim()))
}
function getOrCreateTag(name: string) {
    // get existing with same name
    const existing = Object.entries(get(globalTags)).find(([_id, tag]) => tag.name.toLowerCase() === name.toLowerCase())
    if (existing) return existing[0]

    const tagId = uid(5)
    history({ id: "UPDATE", newData: { data: { name } }, oldData: { id: tagId }, location: { page: "show", id: "tag" } })
    return tagId
}
