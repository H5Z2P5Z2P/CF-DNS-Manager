/**
 * 自动验证配置端点
 * 将 Cloudflare 自定义主机名的验证记录自动添加到 DNSPod
 * 支持自动从主机名提取并匹配 DNSPod 域名
 */

const DNSPOD_HOST = 'dnspod.tencentcloudapi.com';
const DNSPOD_SERVICE = 'dnspod';
const DNSPOD_VERSION = '2021-03-23';

// TC3 签名相关函数
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

async function sha256Hex(message) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function signRequest(secretId, secretKey, action, payload, timestamp) {
    const date = new Date(timestamp * 1000).toISOString().split('T')[0];
    const payloadStr = JSON.stringify(payload);

    const httpRequestMethod = 'POST';
    const canonicalUri = '/';
    const canonicalQueryString = '';
    const signedHeaders = 'content-type;host';
    const hashedPayload = await sha256Hex(payloadStr);
    const canonicalHeaders = `content-type:application/json\nhost:${DNSPOD_HOST}\n`;

    const canonicalRequest = [
        httpRequestMethod, canonicalUri, canonicalQueryString,
        canonicalHeaders, signedHeaders, hashedPayload
    ].join('\n');

    const algorithm = 'TC3-HMAC-SHA256';
    const credentialScope = `${date}/${DNSPOD_SERVICE}/tc3_request`;
    const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
    const stringToSign = [algorithm, timestamp.toString(), credentialScope, hashedCanonicalRequest].join('\n');

    const secretDate = await hmacSha256(`TC3${secretKey}`, date);
    const secretService = await hmacSha256(secretDate, DNSPOD_SERVICE);
    const secretSigning = await hmacSha256(secretService, 'tc3_request');
    const signature = bytesToHex(await hmacSha256(secretSigning, stringToSign));

    return {
        'Authorization': `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        'Content-Type': 'application/json',
        'Host': DNSPOD_HOST,
        'X-TC-Action': action,
        'X-TC-Timestamp': timestamp.toString(),
        'X-TC-Version': DNSPOD_VERSION
    };
}

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

/**
 * 从主机名中提取可能的域名列表
 * 例如 "app.shop.customer.com" -> ["shop.customer.com", "customer.com"]
 */
function extractPossibleDomains(hostname) {
    const parts = hostname.split('.');
    const domains = [];
    // 至少需要2个部分才能构成域名
    for (let i = 1; i < parts.length - 1; i++) {
        domains.push(parts.slice(i).join('.'));
    }
    return domains;
}

/**
 * POST /api/zones/[zoneId]/auto_verify
 * 自动配置验证记录到 DNSPod
 * 
 * 请求体:
 * {
 *   "hostname": "app.customer.com",           // 自定义主机名
 *   "txt_name": "_cf-custom-hostname.app",    // TXT 记录名
 *   "txt_value": "xxxxxxxxxx"                 // TXT 记录值
 * }
 * 
 * 自动从 hostname 提取域名并匹配 DNSPod 中的域名
 */
export async function onRequestPost(context) {
    const { dnspodSecretId, dnspodSecretKey } = context.data;

    if (!dnspodSecretId || !dnspodSecretKey) {
        return new Response(JSON.stringify({
            success: false,
            error: 'DNSPod credentials not configured'
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const body = await context.request.json();
        const { hostname, txt_name, txt_value, record_type = 'TXT' } = body;

        if (!hostname || !txt_name || !txt_value) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Missing required parameters: hostname, txt_name, txt_value'
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 获取 DNSPod 域名列表
        const domainListResult = await callDnspodApi(dnspodSecretId, dnspodSecretKey, 'DescribeDomainList', {});

        if (domainListResult.Response?.Error) {
            return new Response(JSON.stringify({
                success: false,
                error: `DNSPod API error: ${domainListResult.Response.Error.Message}`
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const dnspodDomains = domainListResult.Response?.DomainList || [];
        const dnspodDomainNames = dnspodDomains.map(d => d.Name.toLowerCase());

        // 从主机名提取可能的域名并匹配
        const possibleDomains = extractPossibleDomains(hostname.toLowerCase());
        let matchedDomain = null;

        for (const domain of possibleDomains) {
            if (dnspodDomainNames.includes(domain)) {
                matchedDomain = domain;
                break;
            }
        }

        if (!matchedDomain) {
            return new Response(JSON.stringify({
                success: false,
                error: `No matching domain found in DNSPod for hostname: ${hostname}. Tried: ${possibleDomains.join(', ')}`
            }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 从 txt_name 提取子域名
        let subDomain = txt_name;
        if (txt_name.toLowerCase().endsWith('.' + matchedDomain)) {
            subDomain = txt_name.slice(0, -(matchedDomain.length + 1));
        } else if (txt_name.toLowerCase().endsWith(matchedDomain)) {
            subDomain = txt_name.slice(0, -matchedDomain.length);
            if (subDomain.endsWith('.')) {
                subDomain = subDomain.slice(0, -1);
            }
        }

        if (!subDomain) {
            subDomain = '@';
        }

        // 检查是否已存在同名记录（相同子域名和类型）
        const listResult = await callDnspodApi(dnspodSecretId, dnspodSecretKey, 'DescribeRecordList', {
            Domain: matchedDomain,
            Subdomain: subDomain,
            RecordType: record_type
        });

        // 删除所有同名的旧记录
        if (listResult.Response?.RecordList?.length > 0) {
            for (const oldRecord of listResult.Response.RecordList) {
                // 如果值相同，直接返回成功（避免不必要的删除和创建）
                if (oldRecord.Value === txt_value) {
                    return new Response(JSON.stringify({
                        success: true,
                        message: 'Record already exists with same value',
                        record_id: oldRecord.RecordId,
                        domain: matchedDomain,
                        sub_domain: subDomain
                    }), {
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                // 删除旧记录
                await callDnspodApi(dnspodSecretId, dnspodSecretKey, 'DeleteRecord', {
                    Domain: matchedDomain,
                    RecordId: oldRecord.RecordId
                });
            }
        }

        // 创建新记录
        const createResult = await callDnspodApi(dnspodSecretId, dnspodSecretKey, 'CreateRecord', {
            Domain: matchedDomain,
            SubDomain: subDomain,
            RecordType: record_type,
            RecordLine: '默认',
            Value: txt_value,
            TTL: 600
        });

        if (createResult.Response?.Error) {
            return new Response(JSON.stringify({
                success: false,
                error: createResult.Response.Error.Message,
                code: createResult.Response.Error.Code
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        return new Response(JSON.stringify({
            success: true,
            message: 'Record created successfully',
            record_id: createResult.Response?.RecordId,
            domain: matchedDomain,
            sub_domain: subDomain,
            record_type,
            value: txt_value
        }), {
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
