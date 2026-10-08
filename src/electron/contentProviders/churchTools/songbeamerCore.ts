import { uid } from "uid"
import type { Chords, ID, Item, Layout, Line, Show, Slide, SlideData } from "../../../types/Show"

export type SongbeamerTranslationMethod = "multiline" | "textboxes" | "layouts"

type GlobalGroupResolver = (group: string) => string

interface SongbeamerChord {
    x: number
    line: number
    key: string
}

interface SongbeamerLine {
    text: string
    chords: SongbeamerChord[]
}

class SongbeamerSlide {
    group: string | null = null
    globalGroup: string | null = null
    groupNumber: number | null = null
    lines: SongbeamerLine[][] = []
}

export type SongbeamerMetadata = {
    lang_count: number
    title: string
    author: string
    copyright: string
    composer: string
    publisher: string
    comments: string
    keywords: string
    format: string
    title_format: string
    background_image: string
    number: string
    ccli: string
    tempo: number
    key: string
    chords: SongbeamerChord[][]
    verse_order: { group: string; groupNumber: number | null }[]
}

const SONGBEAMER_METADATA_DEFAULT: SongbeamerMetadata = {
    lang_count: 1,
    title: "",
    author: "",
    copyright: "",
    composer: "",
    publisher: "",
    comments: "",
    keywords: "",
    format: "",
    title_format: "",
    background_image: "",
    number: "",
    ccli: "",
    tempo: 0,
    key: "",
    chords: [],
    verse_order: []
}

const SONGBEAMER_SECTION_RE = /(?:^|\n)--(?:-|A)?\s*\n/

const SONG_BOM8 = String.fromCodePoint(0xef, 0xbb, 0xbf)
const SONG_BOM16 = String.fromCodePoint(0xfeff)

const SONGBEAMER_GROUPS: { [key: string]: string } = {
    unbekannt: "",
    unbenannt: "",
    unknown: "",
    intro: "Intro",
    vers: "Verse",
    verse: "Verse",
    strophe: "Verse",
    "pre-bridge": "Pre-Bridge",
    bridge: "Bridge",
    misc: "Misc",
    "pre-refrain": "Pre-Chorus",
    refrain: "Chorus",
    "pre-chorus": "Pre-Chorus",
    chorus: "Chorus",
    zwischenspiel: "Break",
    instrumental: "Break",
    interlude: "Break",
    "pre-coda": "Pre-Outro",
    coda: "Outro",
    ending: "Outro",
    outro: "Outro",
    teil: "Tag",
    part: "Tag",
    chor: "Tag",
    solo: "Tag"
}

export function toSongbeamerTranslationMethod(method: string | SongbeamerTranslationMethod | null | undefined): SongbeamerTranslationMethod {
    if (method === "textboxes" || method === "layouts" || method === "multiline") {
        return method
    }
    return "multiline"
}

const SONGBEAMER_GLOBAL_GROUPS: { [key: string]: string } = {
    Intro: "intro",
    Verse: "verse",
    "Pre-Bridge": "pre_bridge",
    Bridge: "bridge",
    "Pre-Chorus": "pre_chorus",
    Chorus: "chorus",
    Break: "break",
    "Pre-Outro": "pre_outro",
    Outro: "outro",
    Tag: "tag"
}

function cloneMetadata(): SongbeamerMetadata {
    return {
        ...SONGBEAMER_METADATA_DEFAULT,
        chords: [],
        verse_order: []
    }
}

function getGroupId(group: string | null, groupNumber: number | null): string | null {
    if (!group) return null
    if (groupNumber !== null) return group + groupNumber.toString()
    return group
}

function decodeBase64Utf8(text: string, encoding: BufferEncoding = "utf8"): string {
    let binary = ""

    if (typeof atob === "function") {
        binary = atob(text)
    } else {
        binary = Buffer.from(text, "base64").toString("latin1")
    }

    const bytes = new Uint8Array(binary.length & 1 ? binary.length + 1 : binary.length)
    for (let i = 0; i < bytes.length; ++i) {
        bytes[i] = binary.charCodeAt(i)
    }
    const decoder = new TextDecoder(encoding)
    return decoder.decode(bytes)
}

function slideTagToGroup(line: string): { group: string | null; globalGroup: string | null; groupNumber: number | null } {
    if (line.charAt(0) === "#") return { group: null, globalGroup: null, groupNumber: null }

    const parts: string[] = line.split(" ", 2)
    const tag: string = parts[0].toLowerCase()
    let groupNumber: number | null = null
    if (parts.length > 1) {
        groupNumber = parseInt(parts[1], 10)
        if (isNaN(groupNumber) || groupNumber < 1) groupNumber = null
    }

    let group: string | null = null
    let globalGroup: string | null = null
    if (tag in SONGBEAMER_GROUPS) {
        group = SONGBEAMER_GROUPS[tag]
        if (group in SONGBEAMER_GLOBAL_GROUPS) globalGroup = SONGBEAMER_GLOBAL_GROUPS[group]
    }

    return { group, globalGroup, groupNumber }
}

function convertChord(chord: SongbeamerChord): Chords {
    const pos = Math.ceil(chord.x)
    const key = chord.key.replaceAll("<", "♭").replaceAll("=", "")
    return { id: uid(5), pos, key }
}

function parseSongbeamerSlides(sections: string[], metadata: SongbeamerMetadata): SongbeamerSlide[] {
    const slides: SongbeamerSlide[] = []

    const markerRegex = /^#([a-zA-Z]+)\s+/
    const languageRegex = /^#(#)?(\d)?\s+/
    let chordLine = 0

    for (const section of sections) {
        const slide = new SongbeamerSlide()
        for (let i = 0; i < metadata.lang_count; ++i) {
            slide.lines.push([])
        }

        const lines: string[] = section.split("\n")

        const firstLine: string = lines[0]
        if (firstLine.substring(0, 4) === "$$M=") {
            lines.shift()
            ++chordLine
        } else {
            const { group, globalGroup, groupNumber } = slideTagToGroup(firstLine)
            if (group !== null) {
                lines.shift()
                ++chordLine
                slide.group = group
                slide.globalGroup = globalGroup
                slide.groupNumber = groupNumber
            }
        }

        let language = 0
        let lastLineLanguage = -1
        for (let lineText of lines) {
            const songbeamerChords: SongbeamerChord[] = metadata.chords[chordLine] || []
            ++chordLine
            if (language >= metadata.lang_count) language = 0

            let currentLineLanguage = language
            const line: SongbeamerLine = { text: "", chords: songbeamerChords }

            const marker = markerRegex.exec(lineText)
            if (marker !== null) {
                if (marker[1] === "H") {
                    ++language
                    continue
                }
                lineText = lineText.substring(marker[0].length)
            }

            const langOverwrite = languageRegex.exec(lineText)
            if (langOverwrite === null) {
                line.text = lineText
                if (lineText) ++language
            } else {
                line.text = lineText.substring(langOverwrite[0].length)
                const langNumber = parseInt(langOverwrite[2], 10)
                if (!langOverwrite[1]) ++language
                if (!isNaN(langNumber)) {
                    if (langNumber < 1 || langNumber > metadata.lang_count) continue
                    currentLineLanguage = langNumber - 1
                }
            }

            line.text = line.text.trim()
            if (metadata.lang_count > 1 && currentLineLanguage === lastLineLanguage) {
                slide.lines[currentLineLanguage][slide.lines[currentLineLanguage].length - 1].text += "\n" + line.text
            } else {
                slide.lines[currentLineLanguage].push(line)
            }
            lastLineLanguage = currentLineLanguage
        }

        ++chordLine
        slides.push(slide)
    }

    return slides
}

function getSlideIndexFromLayout(layout: SlideData[], slideId: string): number | null {
    for (let i = 0; i < layout.length; ++i) {
        if (layout[i].id === slideId) return i
    }
    return null
}

function createLayoutFromVerseOrder(metadata: SongbeamerMetadata, groupSlides: Map<string, SlideData>): SlideData[] | null {
    if (!metadata.verse_order.length || !groupSlides.size) return null

    const layout: SlideData[] = []
    for (const { group, groupNumber } of metadata.verse_order) {
        const groupId = getGroupId(group, groupNumber)
        if (!groupId) continue
        const slide = groupSlides.get(groupId)
        if (slide) layout.push(slide)
    }

    return layout
}

function createMultilineTextbox(songbeamerSlide: SongbeamerSlide, itemStyle: string): Item {
    const textbox: Item = { style: itemStyle, lines: [] }
    let lineCount = 0

    songbeamerSlide.lines.forEach((lines) => {
        if (lines.length > lineCount) lineCount = lines.length
    })

    for (let lineIndex = 0; lineIndex < lineCount; ++lineIndex) {
        songbeamerSlide.lines.forEach((lines) => {
            const line: Line = { align: "", text: [{ style: "", value: "" }] }

            if (lineIndex < lines.length) {
                line.text[0].value = lines[lineIndex].text
                const songbeamerChords = lines[lineIndex].chords
                if (songbeamerChords) {
                    const chords: Chords[] = []
                    for (const chord of songbeamerChords) chords.push(convertChord(chord))
                    if (chords.length) line.chords = chords
                }
            }

            textbox.lines?.push(line)
        })
    }

    return textbox
}

function createTextboxForLanguage(songbeamerSlide: SongbeamerSlide, language: number, itemStyle: string): Item {
    const textbox: Item = { style: itemStyle }
    if (language < 0 || language >= songbeamerSlide.lines.length) return textbox

    textbox.lines = songbeamerSlide.lines[language].map(({ text: lineText, chords: songbeamerChords }): Line => {
        const line: Line = { align: "", text: [{ style: "", value: lineText }] }

        if (songbeamerChords) {
            const chords: Chords[] = []
            for (const chord of songbeamerChords) chords.push(convertChord(chord))
            if (chords.length) line.chords = chords
        }

        return line
    })

    return textbox
}

function createSlidesMultipleLanguagesPerSlide(
    songbeamerSlides: SongbeamerSlide[],
    metadata: SongbeamerMetadata,
    translationMethod: SongbeamerTranslationMethod,
    itemStyle: string,
    resolveGlobalGroup?: GlobalGroupResolver
): { slides: { [key: ID]: Slide }; layout: SlideData[]; groupSlides: Map<string, SlideData> } {
    const slides: { [key: ID]: Slide } = {}
    const layout: SlideData[] = []
    const groupSlides: Map<string, SlideData> = new Map()

    let lastSlideId: string | null = null
    let lastGroup: string | null = null
    let lastGroupNumber: number | null = null
    for (const songbeamerSlide of songbeamerSlides) {
        const id: string = uid()

        let isChildSlide = false
        if (songbeamerSlide.group !== null) {
            isChildSlide = songbeamerSlide.group === lastGroup && songbeamerSlide.groupNumber === lastGroupNumber
        } else {
            isChildSlide = lastGroup !== null
        }

        const slide: Slide = {
            group: isChildSlide ? null : songbeamerSlide.group,
            color: null,
            settings: {},
            notes: "",
            items: []
        }
        switch (translationMethod) {
            case "multiline":
                slide.items.push(createMultilineTextbox(songbeamerSlide, itemStyle))
                break

            case "textboxes":
            default:
                for (let language = 0; language < metadata.lang_count; ++language) {
                    slide.items.push(createTextboxForLanguage(songbeamerSlide, language, itemStyle))
                }
                break
        }

        if (!isChildSlide && songbeamerSlide.globalGroup !== null) {
            const globalGroup = resolveGlobalGroup ? resolveGlobalGroup(songbeamerSlide.globalGroup) : songbeamerSlide.globalGroup
            slide.globalGroup = globalGroup || "verse"
        }
        slides[id] = slide

        const group: string | null = getGroupId(songbeamerSlide.group, songbeamerSlide.groupNumber)
        if (isChildSlide && lastSlideId !== null && lastSlideId in slides) {
            const lastSlide = slides[lastSlideId]
            if (!Array.isArray(lastSlide.children)) lastSlide.children = []
            lastSlide.children.push(id)

            const layoutParentSlideIndex = getSlideIndexFromLayout(layout, lastSlideId)
            if (layoutParentSlideIndex !== null) {
                if (!layout[layoutParentSlideIndex].hasOwnProperty("children")) layout[layoutParentSlideIndex].children = {}
                layout[layoutParentSlideIndex].children![id] = {}
            } else {
                const slideData: SlideData = { id }
                layout.push(slideData)
                if (group) groupSlides.set(group, slideData)
            }
        } else {
            const slideData: SlideData = { id }
            layout.push(slideData)
            if (group) groupSlides.set(group, slideData)
        }
        if (!isChildSlide && songbeamerSlide.group !== null) {
            lastSlideId = id
            lastGroup = songbeamerSlide.group
            lastGroupNumber = songbeamerSlide.groupNumber
        }
    }

    return { slides, layout, groupSlides }
}

function createSlidesForLanguage(
    songbeamerSlides: SongbeamerSlide[],
    language: number,
    metadata: SongbeamerMetadata,
    itemStyle: string,
    resolveGlobalGroup?: GlobalGroupResolver
): { slides: { [key: ID]: Slide }; layout: SlideData[]; groupSlides: Map<string, SlideData> } {
    const slides: { [key: ID]: Slide } = {}
    const layout: SlideData[] = []
    const groupSlides: Map<string, SlideData> = new Map()
    if (language < 0 || language >= metadata.lang_count) return { slides, layout, groupSlides }

    let lastSlideId: string | null = null
    let lastGroup: string | null = null
    let lastGroupNumber: number | null = null
    for (const songbeamerSlide of songbeamerSlides) {
        const id: string = uid()

        let isChildSlide = false
        if (songbeamerSlide.group !== null) {
            isChildSlide = songbeamerSlide.group === lastGroup && songbeamerSlide.groupNumber === lastGroupNumber
        } else {
            isChildSlide = lastGroup !== null
        }

        const lineObjects: Line[] = songbeamerSlide.lines[language].map(({ text: lineText, chords: songbeamerChords }): Line => {
            const line: Line = { align: "", text: [{ style: "", value: lineText }] }
            if (songbeamerChords) {
                const chords: Chords[] = []
                for (const chord of songbeamerChords) chords.push(convertChord(chord))
                if (chords.length) line.chords = chords
            }
            return line
        })

        const slide: Slide = {
            group: isChildSlide ? null : songbeamerSlide.group,
            color: null,
            settings: {},
            notes: "",
            items: [{ style: itemStyle, lines: lineObjects }]
        }

        if (!isChildSlide && songbeamerSlide.globalGroup !== null) {
            const globalGroup = resolveGlobalGroup ? resolveGlobalGroup(songbeamerSlide.globalGroup) : songbeamerSlide.globalGroup
            slide.globalGroup = globalGroup || "verse"
        }
        slides[id] = slide

        const group: string | null = getGroupId(songbeamerSlide.group, songbeamerSlide.groupNumber)
        if (isChildSlide && lastSlideId !== null && lastSlideId in slides) {
            const lastSlide = slides[lastSlideId]
            if (!Array.isArray(lastSlide.children)) lastSlide.children = []
            lastSlide.children.push(id)

            const layoutParentSlideIndex = getSlideIndexFromLayout(layout, lastSlideId)
            if (layoutParentSlideIndex !== null) {
                if (!layout[layoutParentSlideIndex].hasOwnProperty("children")) layout[layoutParentSlideIndex].children = {}
                layout[layoutParentSlideIndex].children![id] = {}
            } else {
                const slideData: SlideData = { id }
                layout.push(slideData)
                if (group) groupSlides.set(group, slideData)
            }
        } else {
            const slideData: SlideData = { id }
            layout.push(slideData)
            if (group) groupSlides.set(group, slideData)
        }
        if (!isChildSlide && songbeamerSlide.group !== null) {
            lastSlideId = id
            lastGroup = songbeamerSlide.group
            lastGroupNumber = songbeamerSlide.groupNumber
        }
    }

    return { slides, layout, groupSlides }
}

export function normalizeSongbeamerText(text: string): string {
    return text.replaceAll("\r", "").replaceAll(/\n\s+\n/g, "\n\n")
}

export function stripSongbeamerBom(text: string): string {
    let value = text
    if (value.substring(0, 3) === SONG_BOM8) {
        value = value.substring(3)
    }
    if (value.charAt(0) === SONG_BOM16) {
        value = value.substring(1)
    }
    return value
}

export function parseSongbeamerMetadata(text: string, encoding: BufferEncoding = "utf8"): SongbeamerMetadata {
    const metadata = cloneMetadata()

    text.split("\n").forEach((line: string) => {
        if (!line || line[0] !== "#") return

        const parts = line.substring(1).split("=", 2)
        if (parts.length !== 2) return

        switch (parts[0]) {
            case "LangCount": {
                const langCount = parseInt(parts[1], 10)
                if (!isNaN(langCount) && langCount > 0) metadata.lang_count = langCount
                break
            }
            case "Title":
                metadata.title = parts[1].trim()
                break
            case "Author":
                metadata.author = parts[1].trim()
                break
            case "(c)":
                metadata.copyright = parts[1].trim()
                break
            case "Melody":
                metadata.composer = parts[1].trim()
                break
            case "NatCopyright":
                metadata.publisher = parts[1].trim()
                break
            case "Comments":
                metadata.comments = decodeBase64Utf8(parts[1].trim(), encoding)
                break
            case "Keywords":
                metadata.keywords = parts[1].trim() || ""
                break
            case "Format":
                metadata.format = parts[1].trim()
                break
            case "TitleFormat":
                metadata.title_format = parts[1].trim()
                break
            case "BackgroundImage":
                metadata.background_image = parts[1].trim()
                break
            case "ChurchSongID":
                metadata.number = parts[1].trim() || ""
                break
            case "Key":
                metadata.key = parts[1].trim()
                break
            case "Tempo": {
                const tempo = parseInt(parts[1], 10)
                if (!isNaN(tempo) && tempo > 0) metadata.tempo = tempo
                break
            }
            case "Chords": {
                const chords: string = decodeBase64Utf8(parts[1].trim(), encoding)
                for (const chord of chords.split("\r")) {
                    const chordParts = chord.split(",")
                    const chordLine = parseInt(chordParts[1], 10)
                    if (!Array.isArray(metadata.chords[chordLine])) metadata.chords[chordLine] = []
                    metadata.chords[chordLine].push({ x: parseFloat(chordParts[0]), line: chordLine, key: chordParts[2] })
                }
                break
            }
            case "CCLI": {
                const ccli = parts[1].trim()
                let index = 0
                for (const char of ccli) {
                    if (char < "0" || char > "9") break
                    ++index
                }
                metadata.ccli = ccli.substring(0, index)
                break
            }
            case "VerseOrder": {
                const slideTags = parts[1].trim().split(",")
                for (const tag of slideTags) {
                    const { group, groupNumber } = slideTagToGroup(tag)
                    if (group !== null) metadata.verse_order.push({ group, groupNumber })
                }
                break
            }
        }
    })

    return metadata
}

export function buildSongbeamerLayouts(
    rawText: string,
    settings: {
        translationMethod: SongbeamerTranslationMethod
        itemStyle: string
        encoding?: BufferEncoding
        resolveGlobalGroup?: GlobalGroupResolver
    }
): {
    metadata: SongbeamerMetadata
    slides: { [key: ID]: Slide }
    layouts: Layout[]
} {
    const normalized = normalizeSongbeamerText(rawText)
    const sections: string[] = normalized.split(SONGBEAMER_SECTION_RE)
    const metadata = parseSongbeamerMetadata(sections[0], settings.encoding || "utf8")
    sections.shift()

    const songbeamerSlides = parseSongbeamerSlides(sections, metadata)
    const layouts: Layout[] = []
    let slides: { [key: ID]: Slide } = {}

    switch (settings.translationMethod) {
        case "multiline":
        case "textboxes": {
            const slidesMultiLang = createSlidesMultipleLanguagesPerSlide(songbeamerSlides, metadata, settings.translationMethod, settings.itemStyle, settings.resolveGlobalGroup)
            slides = slidesMultiLang.slides
            layouts.push({ name: "", notes: "", slides: createLayoutFromVerseOrder(metadata, slidesMultiLang.groupSlides) || slidesMultiLang.layout })
            break
        }

        case "layouts": {
            for (let language = 0; language < metadata.lang_count; ++language) {
                const { slides: languageSlides, layout: languageLayout, groupSlides } = createSlidesForLanguage(songbeamerSlides, language, metadata, settings.itemStyle, settings.resolveGlobalGroup)
                slides = { ...slides, ...languageSlides }
                layouts.push({ id: uid(), name: `Language ${language + 1}`, notes: "", slides: createLayoutFromVerseOrder(metadata, groupSlides) || languageLayout })
            }
            break
        }
    }

    layouts[0]?.slides?.forEach(({ id }) => {
        if (slides[id] && !slides[id].group) {
            slides[id].group = ""
            slides[id].globalGroup = "verse"
        }
    })

    return { metadata, slides, layouts }
}

export function applySongbeamerLayoutsToShow(
    show: Show,
    activeLayoutId: string,
    conversion: { slides: { [key: ID]: Slide }; layouts: Layout[] },
    options: {
        baseNotes?: string
        defaultLayoutName?: string
        useFirstLayoutNotes?: boolean
    } = {}
): Show {
    show.slides = conversion.slides

    if (options.baseNotes !== undefined) {
        show.layouts[activeLayoutId].notes = options.baseNotes
    }

    const firstLayout = conversion.layouts[0]
    if (firstLayout) {
        show.layouts[activeLayoutId].name = firstLayout.name || options.defaultLayoutName || show.layouts[activeLayoutId].name
        show.layouts[activeLayoutId].slides = firstLayout.slides
        if (options.useFirstLayoutNotes) {
            show.layouts[activeLayoutId].notes = firstLayout.notes
        }
    }

    for (let i = 1; i < conversion.layouts.length; ++i) {
        const layout = conversion.layouts[i]
        if (layout.id) {
            show.layouts[layout.id] = layout
        }
    }

    return show
}

type SongbeamerInputFile = {
    name: string
    content: string
}

export function convertSongbeamerFiles<TSettings>(
    files: SongbeamerInputFile[],
    settings: TSettings,
    convertSongbeamerFileToShow: (name: string, text: string, settings: TSettings) => Show,
    createShowId: () => string = () => uid()
): { id: string; show: Show }[] {
    const convertedShows: { id: string; show: Show }[] = []

    files.forEach(({ name, content }) => {
        const show = convertSongbeamerFileToShow(name, stripSongbeamerBom(content), settings)
        convertedShows.push({ id: createShowId(), show })
    })

    return convertedShows
}

export function convertSongbeamerFileToData(
    name: string,
    text: string,
    settings: {
        translationMethod: SongbeamerTranslationMethod
        itemStyle: string
        encoding?: BufferEncoding
        resolveGlobalGroup?: GlobalGroupResolver
    }
): {
    metadata: SongbeamerMetadata
    slides: { [key: ID]: Slide }
    layouts: Layout[]
} {
    const { metadata, slides, layouts } = buildSongbeamerLayouts(stripSongbeamerBom(text), settings)
    if (!metadata.title) {
        metadata.title = name
    }
    return { metadata, slides, layouts }
}
