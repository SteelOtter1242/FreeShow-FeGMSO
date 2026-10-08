import { get } from "svelte/store"
import { uid } from "uid"
import type { Show } from "../../types/Show"
import { TranslationMethod } from "../../types/Songbeamer"
import { applySongbeamerLayoutsToShow, convertSongbeamerFileToData, convertSongbeamerFiles as convertSongbeamerFilesCore, toSongbeamerTranslationMethod } from "../../shared/songbeamer/songbeamerCore"
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
}

export function convertSongbeamerFiles({ files = [], category = "Songbeamer", translationMethod = TranslationMethod.MultiLine, encoding = "utf8" }: any) {
    const settings: ImportSettings = {
        category,
        encoding,
        translationMethod
    }

    const tempShows: { id: string; show: Show }[] = convertSongbeamerFilesCore(files, settings, convertSongbeamerFileToShow)
    setTempShows(tempShows)
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

    const { metadata, slides, layouts } = convertSongbeamerFileToData(name, text, {
        translationMethod: toSongbeamerTranslationMethod(settings.translationMethod),
        itemStyle: DEFAULT_ITEM_STYLE,
        encoding: settings.encoding,
        resolveGlobalGroup: (group: string): string => getGlobalGroup(group)
    })

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
