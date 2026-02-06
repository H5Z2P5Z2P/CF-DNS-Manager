/**
 * DNSPod API 代理
 * 支持腾讯云 DNS API v3，使用 TC3-HMAC-SHA256 签名
 */

const DNSPOD_HOST = 'dnspod.tencentcloudapi.com';
const DNSPOD_SERVICE = 'dnspod';
const DNSPOD_VERSION = '2021-03-23';

/**
 * 计算 HMAC-SHA256
 */
async function hmacSha256(key, message) {
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        typeof key === 'string' ? new TextEncoder().encode(key) : key,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
    return new Uint8Array(signature);
}

/**
 * 计算 SHA256 哈希
 */
async function sha256Hex(message) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 字节数组转十六进制字符串
 */
function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * TC3-HMAC-SHA256 签名
 * @param {string} secretId - 腾讯云 SecretId
 * @param {string} secretKey - 腾讯云 SecretKey
 * @param {string} action - API Action 名称
 * @param {object} payload - 请求体
 * @param {number} timestamp - Unix 时间戳（秒）
 * @returns {object} 签名后的请求头
 */
async function signRequest(secretId, secretKey, action, payload, timestamp) {
    const date = new Date(timestamp * 1000).toISOString().split('T')[0]; // YYYY-MM-DD
    const payloadStr = JSON.stringify(payload);

    // Step 1: 拼接规范请求串
    const httpRequestMethod = 'POST';
    const canonicalUri = '/';
    const canonicalQueryString = '';
    const signedHeaders = 'content-type;host';
    const hashedPayload = await sha256Hex(payloadStr);
    const canonicalHeaders = `content-type:application/json\nhost:${DNSPOD_HOST}\n`;

    const canonicalRequest = [
        httpRequestMethod,
        canonicalUri,
        canonicalQueryString,
        canonicalHeaders,
        signedHeaders,
        hashedPayload
    ].join('\n');

    // Step 2: 拼接待签名字符串
    const algorithm = 'TC3-HMAC-SHA256';
    const credentialScope = `${date}/${DNSPOD_SERVICE}/tc3_request`;
    const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
    const stringToSign = [
        algorithm,
        timestamp.toString(),
        credentialScope,
        hashedCanonicalRequest
    ].join('\n');

    // Step 3: 计算签名
    const secretDate = await hmacSha256(`TC3${secretKey}`, date);
    const secretService = await hmacSha256(secretDate, DNSPOD_SERVICE);
    const secretSigning = await hmacSha256(secretService, 'tc3_request');
    const signature = bytesToHex(await hmacSha256(secretSigning, stringToSign));

    // Step 4: 构造 Authorization
    const authorization = `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
        'Authorization': authorization,
        'Content-Type': 'application/json',
        'Host': DNSPOD_HOST,
        'X-TC-Action': action,
        'X-TC-Timestamp': timestamp.toString(),
        'X-TC-Version': DNSPOD_VERSION
    };
}

/**
 * 调用 DNSPod API
 */
async function callDnspodApi(secretId, secretKey, action, payload = {}) {
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = await signRequest(secretId, secretKey, action, payload, timestamp);

    const response = await fetch(`https://${DNSPOD_HOST}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

    return response.json();
}

// GET: 检查 DNSPod 是否配置
export async function onRequestGet(context) {
    const { dnspodSecretId, dnspodSecretKey } = context.data;

    return new Response(JSON.stringify({
        configured: !!(dnspodSecretId && dnspodSecretKey)
    }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

// POST: 代理 DNSPod API 请求
export async function onRequestPost(context) {
    const { dnspodSecretId, dnspodSecretKey } = context.data;

    if (!dnspodSecretId || !dnspodSecretKey) {
        return new Response(JSON.stringify({
            success: false,
            error: 'DNSPod credentials not configured. Please set DNSPOD_SECRET_ID and DNSPOD_SECRET_KEY environment variables.'
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const body = await context.request.json();
        const { action, ...payload } = body;

        if (!action) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Missing action parameter'
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 限制可调用的 Actions（安全考虑）
        const allowedActions = [
            'DescribeDomainList',
            'DescribeRecordList',
            'CreateRecord',
            'ModifyRecord',
            'DeleteRecord'
        ];

        if (!allowedActions.includes(action)) {
            return new Response(JSON.stringify({
                success: false,
                error: `Action '${action}' is not allowed`
            }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const result = await callDnspodApi(dnspodSecretId, dnspodSecretKey, action, payload);

        return new Response(JSON.stringify({
            success: !result.Response?.Error,
            ...result
        }), {
            status: result.Response?.Error ? 400 : 200,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(JSON.stringify({
            success: false,
            error: error.message || 'Internal server error'
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
