import { get } from "svelte/store"
import { Main } from "../../../types/IPC/Main"
import { sendMain } from "../../IPC/main"
import { contentProviderData, events } from "../../stores"
import { newToast } from "../common"
import { buildChurchToolsLoadData } from "./loadData"

export function importChurchToolsEventDay(eventId: string) {
    const event = get(events)?.[eventId]
    if (!event) return

    if (!event.origin?.startsWith("ct_cal_")) {
        newToast("This calendar event is not from ChurchTools sync")
        return
    }

    const fromDate = new Date(event.from)
    if (isNaN(fromDate.getTime())) {
        newToast("Could not read the selected event date")
        return
    }

    // Sync only the selected day from the calendar event.
    const pad = (n: number) => String(n).padStart(2, "0")
    const selectedDay = `${fromDate.getFullYear()}-${pad(fromDate.getMonth() + 1)}-${pad(fromDate.getDate())}`
    const from = selectedDay
    const to = selectedDay

    const providerData = get(contentProviderData)?.churchtools || {}
    sendMain(Main.PROVIDER_LOAD_SERVICES, {
        providerId: "churchtools",
        cloudOnly: false,
        data: buildChurchToolsLoadData(providerData, { interactive: false, importProjectsOnly: true, requiredScope: "api", from, to })
    })

    newToast(`ChurchTools import started for ${selectedDay}`)
}
