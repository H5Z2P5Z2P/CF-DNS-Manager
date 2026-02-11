export async function onRequest(context) {
    const { request, env, next } = context;
    const url = new URL(request.url);

    // Skip auth for login API
    if (url.pathname === '/api/login') {
        return next();
    }

    // Get tokens from headers
    const clientToken = request.headers.get('X-Cloudflare-Token');
    const authHeader = request.headers.get('Authorization');

    // Priority 1: Client Mode (Token provided directly by user)
    if (clientToken) {
        context.data.cfToken = clientToken;
        return next();
    }

    // Priority 2: Server Mode (JWT provided, using server's CF_API_TOKEN)
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const serverSecret = env.APP_PASSWORD;

        if (!serverSecret) {
            return new Response(JSON.stringify({ error: 'Server-side Managed Mode is not configured (missing APP_PASSWORD).' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        try {
            const { jwtVerify } = await import('jose');
            const secret = new TextEncoder().encode(serverSecret);
            await jwtVerify(token, secret);

            // JWT is valid
            const accountIndex = parseInt(request.headers.get('X-Managed-Account-Index') || '0');
            let serverToken = env.CF_API_TOKEN;
            if (accountIndex > 0) {
                serverToken = env[`CF_API_TOKEN${accountIndex}`];
            }

            if (!serverToken) {
                return new Response(JSON.stringify({ error: 'Selected managed account is not configured.' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            context.data.cfToken = serverToken;
            // Inject DNSPod credentials for managed mode
            context.data.dnspodSecretId = env.DNSPOD_SECRET_ID;
            context.data.dnspodSecretKey = env.DNSPOD_SECRET_KEY;
            // 注入 Komari 凭证
            context.data.komariBaseUrl = env.KOMARI_BASE_URL;
            context.data.komariApiToken = env.KOMARI_API_TOKEN;
            return next();
        } catch (e) {
            return new Response(JSON.stringify({ error: 'Invalid or expired session.', message: e.message }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }

    // No valid auth method found
    return new Response(JSON.stringify({
        error: 'Authentication Required',
        message: 'Please provide either X-Cloudflare-Token or a valid Authorization header.'
    }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
    });
}
