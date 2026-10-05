/**
 * ChurchTools provider — sole public interface for all ChurchTools functionality.
 *
 * WARNING: This is the ONLY class that should import from connect.ts and request.ts.
 * All external code should use this provider through ContentProviderRegistry.
 */

import { ContentProvider } from "../base/ContentProvider"
import { ctConnect, ctDisconnect, ctInitialize, ctStartupLoad } from "./connect"
import { ctLoadServices } from "./request"
import type { CTScopes } from "./types"

export type { CTScopes } from "./types"

type CTConnectPayload = {
    url?: string
    sngFolder?: string
    sngTranslationMethod?: "multiline" | "textboxes"
    weeksBack?: number
    weeksAhead?: number
    clientId?: string
    clientSecret?: string
    interactive?: boolean
}

type CTLoadPayload = CTConnectPayload & {
    serviceId?: number
    from?: string
    to?: string
    importProjectsOnly?: boolean
}

export interface CTAuthDataExport {
    access_token: string
    refresh_token: string
    token_type: "Bearer"
    created_at: number
    expires_in: number
    scope: string
    domain: string
}

export class ChurchToolsProvider extends ContentProvider<CTScopes, CTAuthDataExport> {
    constructor() {
        super({
            providerId: "churchtools",
            displayName: "ChurchTools",
            port: 5504,
            clientId: "",
            clientSecret: "",
            apiUrl: "", // dynamic per installation
            scopes: ["services"] as const
        })
    }

    isConnected(_scope: CTScopes): boolean {
        return this.access !== null
    }

    async connect(_scope: CTScopes, data?: CTConnectPayload): Promise<CTAuthDataExport | null> {
        const interactive = data?.interactive !== false
        const connectData = data
            ? {
                url: data.url,
                sngFolder: data.sngFolder,
                sngTranslationMethod: data.sngTranslationMethod,
                weeksBack: data.weeksBack,
                weeksAhead: data.weeksAhead,
                clientId: data.clientId,
                clientSecret: data.clientSecret
            }
            : undefined
        const result = await ctConnect(connectData, { interactive })
        this.access = result as CTAuthDataExport | null
        return this.access
    }

    disconnect(_scope?: CTScopes): void {
        ctDisconnect()
        this.access = null
    }

    async apiRequest(_data: any): Promise<any> {
        return null // all requests go through request.ts directly
    }

    async loadServices(data?: CTLoadPayload): Promise<void> {
        const connected = await this.connect("services", data)
        if (!connected) return
        return ctLoadServices(data?.serviceId, data?.from, data?.to, data?.importProjectsOnly)
    }

    async startupLoad(_scope: CTScopes, data?: CTLoadPayload): Promise<void> {
        ctInitialize()
        const connectData: CTConnectPayload | undefined = data
            ? {
                url: data.url,
                sngFolder: data.sngFolder,
                sngTranslationMethod: data.sngTranslationMethod,
                weeksBack: data.weeksBack,
                weeksAhead: data.weeksAhead,
                clientId: data.clientId,
                clientSecret: data.clientSecret
            }
            : undefined
        await ctStartupLoad(() => ctLoadServices(data?.serviceId, data?.from, data?.to, data?.importProjectsOnly), connectData)
    }

    protected handleAuthCallback(_req: any, _res: any): void {}
    protected async refreshToken(_scope: CTScopes): Promise<CTAuthDataExport | null> { return null }
    protected async authenticate(_scope: CTScopes): Promise<CTAuthDataExport | null> { return null }
}
