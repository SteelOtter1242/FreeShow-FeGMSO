/**
 * WARNING: This file should ONLY be accessed through ChurchToolsProvider.
 * Do not import or use functions from this file directly in other parts of the application.
 * Use ContentProviderRegistry or ChurchToolsProvider instead.
 */

import { createHash, randomFillSync } from "crypto"
import { ToMain } from "../../../types/IPC/ToMain"
import { getContentProviderAccess, setContentProviderAccess } from "../../data/contentProviders"
import { sendToMain } from "../../IPC/main"
import { openURL } from "../../IPC/responsesMain"
import { httpsRequest } from "../../utils/requests"
import type { CTAuthData, CTScopes } from "./types"

export const CT_SCOPE: CTScopes = "services"
const CT_PORT = 5504
const DEFAULT_CT_CLIENT_ID = process.env.CHURCHTOOLS_CLIENT_ID || "freeshow"
const DEFAULT_CT_CLIENT_SECRET = process.env.CHURCHTOOLS_CLIENT_SECRET || ""
const OAUTH_SCOPE = ""
const AUTH_FLOW_TIMEOUT_MS = 10 * 60 * 1000

type CTConnectData = {
    url?: string
    sngFolder?: string
    sngTranslationMethod?: "multiline" | "textboxes"
    weeksAhead?: number
    clientId?: string
    clientSecret?: string
}

// In-memory cache for the current session
let CT_ACCESS: CTAuthData = null
let pendingAuth: Promise<CTAuthData> | null = null
let pendingAuthUrl = ""
let announcedThisRun = false

const HTML_SUCCESS = `
    <head>
        <title>Success!</title>
    </head>
    <body style="padding: 80px;background: #242832;color: #f0f0ff;font-family: system-ui;font-size: 1.2em;">
        <h1 style="color: #f0008c;">Success!</h1>
        <p>You can close this page</p>
    </body>
`

const HTML_ERROR = `
    <head>
        <title>Error!</title>
    </head>
    <body style="padding: 80px;background: #242832;color: #f0f0ff;font-family: system-ui;font-size: 1.2em;">
        <h1>Could not complete authentication!</h1>
        <p>{error_msg}</p>
    </body>
`

function normalizeDomain(url: string): string {
    return url.trim().replace(/^https?:\/\//, "").replace(/\/api\/?$/, "").replace(/\/$/, "")
}

function whoami(domain: string, token: string): Promise<any> {
    return new Promise((resolve) => {
        const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" }
        httpsRequest(domain, "/api/whoami", "GET", headers, {}, (err, result) => resolve(err ? null : result))
    })
}

function hasExpired(access: CTAuthData): boolean {
    if (!access?.created_at || !access?.expires_in) return true
    const now = Math.floor(Date.now() / 1000)
    return access.created_at + access.expires_in - 30 <= now
}

function mergeSettings(access: NonNullable<CTAuthData>, data?: CTConnectData): NonNullable<CTAuthData> {
    const updated = { ...access }
    if (data?.sngFolder !== undefined) updated.sngFolder = data.sngFolder?.trim() || undefined
    if (data?.sngTranslationMethod !== undefined) updated.sngTranslationMethod = data.sngTranslationMethod
    if (data?.weeksAhead !== undefined) updated.weeksAhead = data.weeksAhead
    if (data?.clientId !== undefined) updated.clientId = data.clientId?.trim() || DEFAULT_CT_CLIENT_ID
    if (data?.clientSecret !== undefined) updated.clientSecret = data.clientSecret || ""
    return updated
}

function saveAccess(access: NonNullable<CTAuthData>): NonNullable<CTAuthData> {
    setContentProviderAccess("churchtools", CT_SCOPE, access)
    CT_ACCESS = access
    return access
}

function refreshToken(access: NonNullable<CTAuthData>): Promise<CTAuthData> {
    return new Promise((resolve) => {
        if (!access.refresh_token) return resolve(null)

        const params: Record<string, string> = {
            grant_type: "refresh_token",
            client_id: access.clientId || DEFAULT_CT_CLIENT_ID,
            refresh_token: access.refresh_token
        }
        if (access.clientSecret) params.client_secret = access.clientSecret

        httpsRequest(access.domain, "/oauth/token", "POST", {}, params, (err, data) => {
            if (err || !data?.access_token) return resolve(null)

            const refreshed: NonNullable<CTAuthData> = {
                ...access,
                ...data,
                token_type: "Bearer",
                created_at: data.created_at || Math.floor(Date.now() / 1000),
                expires_in: data.expires_in || access.expires_in || 3600,
                scope: CT_SCOPE,
                domain: access.domain,
                clientId: access.clientId,
                clientSecret: access.clientSecret
            }
            resolve(saveAccess(refreshed))
        })
    })
}

function generateCodeVerifier() {
    const array = new Uint8Array(32)
    randomFillSync(array)
    return Buffer.from(array).toString("base64url")
}

function generateCodeChallenge(verifier: string) {
    const hash = createHash("sha256").update(verifier).digest()
    return Buffer.from(hash).toString("base64url")
}

function startAuthentication(domain: string, clientId: string, clientSecret: string): Promise<CTAuthData> {
    const express = require("express")
    const app = express()
    const path = "/auth/complete"
    const redirectUri = `http://localhost:${CT_PORT}${path}`
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)

    app.use(express.json())

    return new Promise((resolve) => {
        let settled = false
        const finish = (result: CTAuthData) => {
            if (settled) return
            settled = true
            clearTimeout(abandonTimer)
            server.close()
            resolve(result)
        }

        const abandonTimer = setTimeout(() => finish(null), AUTH_FLOW_TIMEOUT_MS)

        const server = app.listen(CT_PORT, () => {
            console.info(`Listening for ChurchTools OAuth response at port ${CT_PORT}`)
        })

        server.once("error", (err: Error) => {
            if ((err as any).code === "EADDRINUSE") finish(null)
        })

        app.get(path, (req: any, res: any) => {
            const code = req.query.code?.toString() || ""
            if (!code) return finish(null)

            const params: Record<string, string> = {
                grant_type: "authorization_code",
                code,
                client_id: clientId,
                redirect_uri: redirectUri,
                code_verifier: codeVerifier
            }
            if (clientSecret) params.client_secret = clientSecret

            httpsRequest(domain, "/oauth/token", "POST", {}, params, (err, data) => {
                if (err || !data?.access_token) {
                    res.setHeader("Content-Type", "text/html")
                    res.send(HTML_ERROR.replace("{error_msg}", err?.message || "Could not receive access token"))
                    sendToMain(ToMain.ALERT, "Could not authorize ChurchTools. Please verify domain and OAuth client settings.")
                    return finish(null)
                }

                res.setHeader("Content-Type", "text/html")
                res.send(HTML_SUCCESS)

                const authData: NonNullable<CTAuthData> = {
                    ...data,
                    token_type: "Bearer",
                    created_at: data.created_at || Math.floor(Date.now() / 1000),
                    expires_in: data.expires_in || 3600,
                    scope: CT_SCOPE,
                    domain,
                    clientId,
                    clientSecret: clientSecret || ""
                }

                finish(saveAccess(authData))
            })
        })

        const query = new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: "code",
            code_challenge: codeChallenge,
            code_challenge_method: "S256"
        })
        if (OAUTH_SCOPE) query.set("scope", OAUTH_SCOPE)

        pendingAuthUrl = `https://${domain}/oauth/authorize?${query.toString()}`
        openURL(pendingAuthUrl)
    })
}

function authenticate(domain: string, clientId: string, clientSecret: string): Promise<CTAuthData> {
    if (pendingAuth) {
        if (pendingAuthUrl) openURL(pendingAuthUrl)
        return pendingAuth
    }

    pendingAuth = startAuthentication(domain, clientId, clientSecret)
    pendingAuth.finally(() => {
        pendingAuth = null
        pendingAuthUrl = ""
    })
    return pendingAuth
}

export function ctInitialize(): void {
    CT_ACCESS = null
    announcedThisRun = false
}

export function ctGetAccess(): CTAuthData {
    return CT_ACCESS ?? (getContentProviderAccess("churchtools", CT_SCOPE) as CTAuthData)
}

export async function ctConnect(data?: CTConnectData, options: { interactive?: boolean } = {}): Promise<CTAuthData> {
    const interactive = options.interactive !== false
    const stored = (getContentProviderAccess("churchtools", CT_SCOPE) as CTAuthData) || null
    const inputDomain = data?.url?.trim() ? normalizeDomain(data.url) : ""

    const baseDomain = inputDomain || stored?.domain || ""
    if (!baseDomain) {
        if (interactive) sendToMain(ToMain.ALERT, "Enter your ChurchTools domain before connecting.")
        return null
    }

    const clientId = data?.clientId?.trim() || stored?.clientId || DEFAULT_CT_CLIENT_ID
    const clientSecret = data?.clientSecret ?? stored?.clientSecret ?? DEFAULT_CT_CLIENT_SECRET

    let access: CTAuthData = CT_ACCESS || stored
    if (access?.domain && access.domain !== baseDomain) access = null

    if (access) {
        access = {
            ...access,
            domain: baseDomain,
            clientId,
            clientSecret,
            scope: CT_SCOPE
        }
    }

    if (access && hasExpired(access)) {
        access = await refreshToken(access)
    }

    if (access?.access_token) {
        const verified = await whoami(baseDomain, access.access_token)
        if (!verified?.data?.id) access = null
    }

    if (!access && interactive) {
        access = await authenticate(baseDomain, clientId, clientSecret)
    }
    if (!access) return null

    const merged = mergeSettings({ ...access, domain: baseDomain, clientId, clientSecret }, data)
    saveAccess(merged)

    if (!announcedThisRun) {
        const hadStoredAccess = !!stored?.access_token
        sendToMain(ToMain.PROVIDER_CONNECT, { providerId: "churchtools", success: true, isFirstConnection: !hadStoredAccess })
        announcedThisRun = true
    }

    return merged
}

export function ctDisconnect(): void {
    setContentProviderAccess("churchtools", CT_SCOPE, null)
    CT_ACCESS = null
    announcedThisRun = false
}

export async function ctStartupLoad(loadFn: () => Promise<void>, data?: CTConnectData): Promise<void> {
    const access = await ctConnect(data, { interactive: false })
    if (!access) return
    await loadFn()
}
