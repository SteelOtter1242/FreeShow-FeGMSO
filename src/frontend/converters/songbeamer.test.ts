import { describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => {
    const makeStore = (initial: unknown) => {
        let value = initial
        return {
            set: (next: unknown) => {
                value = next
            },
            update: (updater: (current: unknown) => unknown) => {
                value = updater(value)
            },
            _set: (next: unknown) => (value = next),
            subscribe: (run: (value: unknown) => void) => {
                run(value)
                return () => {}
            }
        }
    }

    return {
        activePopup: makeStore(null),
        alertMessage: makeStore(""),
        categories: makeStore({ songbeamer: { name: "Songbeamer" } }),
        drawerTabsData: makeStore({ shows: { activeSubTab: "songbeamer" } }),
        globalTags: makeStore({}),
        capturedTempShows: [] as { id: string; show: any }[]
    }
})

vi.mock("../stores", () => {
    return {
        activePopup: h.activePopup,
        alertMessage: h.alertMessage,
        categories: h.categories,
        drawerTabsData: h.drawerTabsData,
        globalTags: h.globalTags
    }
})

vi.mock("../classes/Show", () => ({
    ShowObj: class {
        name = ""
        origin = ""
        category: string | null
        settings: { activeLayout: string }
        quickAccess: Record<string, unknown> = {}
        meta: Record<string, unknown> = {}
        slides: Record<string, unknown> = {}
        layouts: Record<string, { name: string; notes: string; slides: any[] }>

        constructor(_isPrivate = false, category: string | null = null, layoutId: string) {
            this.category = category
            this.settings = { activeLayout: layoutId }
            this.layouts = { [layoutId]: { name: "", notes: "", slides: [] } }
        }
    }
}))

vi.mock("../components/helpers/show", () => ({
    checkName: (name: string) => name,
    getGlobalGroup: () => "verse"
}))

vi.mock("../components/helpers/array", () => ({
    clone: <T>(value: T) => {
        try {
            return structuredClone(value)
        } catch {
            return JSON.parse(JSON.stringify(value)) as T
        }
    }
}))

vi.mock("../components/helpers/history", () => ({ history: vi.fn() }))
vi.mock("../components/helpers/setShow", () => ({ setQuickAccessMetadata: (show: any) => show }))
vi.mock("../utils/language", () => ({ translateText: (value: string) => value }))

vi.mock("../components/edit/scripts/itemHelpers", () => ({
    DEFAULT_ITEM_STYLE: "top:0;left:0;height:100px;width:100px;"
}))

vi.mock("./importHelpers", () => ({
    createCategory: () => "songbeamer",
    setTempShows: (tempShows: { id: string; show: any }[]) => {
        h.capturedTempShows = tempShows
    }
}))

import { convertSongbeamerFiles } from "./songbeamer"

function layoutNotes(show: any): string {
    const layoutId = show.settings.activeLayout
    return show.layouts[layoutId]?.notes || ""
}

function slideText(show: any): string {
    const slides = Object.values(show?.slides || {}) as any[]
    return slides
        .flatMap((slide) => slide?.items || [])
        .flatMap((item) => item?.lines || [])
        .flatMap((line) => line?.text || [])
        .map((segment) => segment?.value || "")
        .join("\n")
}

describe("convertSongbeamerFiles mixed metadata encoding", () => {
    it("decodes base64 comments with each file's own detected encoding", async () => {
        h.capturedTempShows = []

        const utf8Song = "#Title=UTF8\n#Comments=w6Q=\n--\nVerse 1\nfür"
        const latin1Song = "#Title=Latin1\n#Comments=5A==\n--\nVerse 1\nfür"

        convertSongbeamerFiles([
            { name: "utf8", content: utf8Song, encoding: "utf8" },
            { name: "latin1", content: latin1Song, encoding: "latin1" }
        ])

        await new Promise((resolve) => setTimeout(resolve, 20))

        expect(h.capturedTempShows).toHaveLength(2)

        const utf8Show = h.capturedTempShows.find(({ show }) => show.name === "UTF8")?.show
        const latin1Show = h.capturedTempShows.find(({ show }) => show.name === "Latin1")?.show

        expect(layoutNotes(utf8Show)).toBe("ä")
        expect(layoutNotes(latin1Show).replaceAll("\u0000", "")).toBe("ä")
        expect(slideText(utf8Show)).toContain("für")
        expect(slideText(latin1Show)).toContain("für")
    })
})
