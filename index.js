require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActivityType } = require('discord.js');
const axios = require('axios');
const fs = require('fs');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const TOKEN          = process.env.DISCORD_TOKEN;
const CHANNEL_ID     = process.env.CHANNEL_ID;
const ROLE_ID        = process.env.ROLE_ID || '';
const CHECK_INTERVAL = (parseInt(process.env.CHECK_INTERVAL_MINUTES) || 5) * 60 * 1000;
const DATA_FILE      = './last_versions.json';
const API_URL        = 'https://weao.xyz/api/versions/current';
const USER_AGENT     = 'WEAO-3PService'; // Bắt buộc theo tài liệu WEAO

const PLATFORMS = ['Windows', 'Mac', 'Android', 'iOS'];

const PLATFORM_ICONS = {
    Windows: '🪟',
    Mac:     '🍎',
    Android: '🤖',
    iOS:     '📱',
};

// ─── CLIENT ──────────────────────────────────────────────────────────────────
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function log(level, message) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const icons = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌', update: '🚀' };
    console.log(`[${time}] ${icons[level] || '•'} ${message}`);
}

function loadSavedVersions() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
    } catch (err) {
        log('warn', `Không đọc được file dữ liệu cũ, tạo mới. (${err.message})`);
    }
    return { Windows: '', Mac: '', Android: '', iOS: '' };
}

function saveVersions(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 4));
    } catch (err) {
        log('error', `Không lưu được file dữ liệu: ${err.message}`);
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── API FETCH (có retry) ─────────────────────────────────────────────────────
async function fetchCurrentVersions(retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.get(API_URL, {
                headers: { 'User-Agent': USER_AGENT },
                timeout: 10_000,
            });
            return response.data;
        } catch (err) {
            // Rate limit — đọc thời gian chờ từ response của WEAO
            if (err.response?.status === 429) {
                const waitMs = (err.response.data?.rateLimitInfo?.remainingTime ?? 120) * 1000;
                log('warn', `Rate limit! Chờ ${waitMs / 1000}s rồi thử lại...`);
                await sleep(waitMs);
                continue;
            }

            // Lỗi mạng thông thường — retry có delay tăng dần
            if (attempt < retries) {
                const delay = attempt * 5000;
                log('warn', `Lỗi lần ${attempt}/${retries}: ${err.message}. Thử lại sau ${delay / 1000}s...`);
                await sleep(delay);
            } else {
                throw err;
            }
        }
    }
}

// ─── BUILD EMBED ──────────────────────────────────────────────────────────────
function buildUpdateEmbed(updates) {
    const platformList = updates.map((u) => u.platform).join(', ');

    const embed = new EmbedBuilder()
        .setTitle('🚨 Roblox vừa có bản cập nhật mới!')
        .setDescription(`Phát hiện cập nhật trên: **${platformList}**`)
        .setColor(0xff5555)
        .setFooter({ text: 'WEAO Version Tracker • weao.xyz' })
        .setTimestamp();

    for (const { platform, oldVer, newVer, date } of updates) {
        embed.addFields({
            name: `${PLATFORM_ICONS[platform]} ${platform}`,
            value: [
                `> **Bản cũ:** \`${oldVer || 'Chưa có dữ liệu'}\``,
                `> **Bản mới:** \`${newVer}\``,
                `> **Thời gian:** ${date}`,
            ].join('\n'),
            inline: false,
        });
    }

    return embed;
}

// ─── CORE CHECK ───────────────────────────────────────────────────────────────
async function checkRobloxUpdates() {
    log('info', 'Đang kiểm tra phiên bản Roblox...');

    let currentData;
    try {
        currentData = await fetchCurrentVersions();
    } catch (err) {
        log('error', `Không lấy được dữ liệu từ API: ${err.message}`);
        return;
    }

    const savedData = loadSavedVersions();
    const updates   = [];

    for (const platform of PLATFORMS) {
        const currentVer = currentData[platform];
        const savedVer   = savedData[platform];
        const date       = currentData[`${platform}Date`] || 'Không rõ thời gian';

        if (currentVer && currentVer !== savedVer) {
            updates.push({ platform, oldVer: savedVer, newVer: currentVer, date });
            savedData[platform] = currentVer;
        }
    }

    if (updates.length === 0) {
        log('success', 'Chưa có bản cập nhật nào mới.');
        return;
    }

    // Gửi thông báo Discord
    try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        if (!channel) {
            log('error', `Không tìm thấy kênh với ID: ${CHANNEL_ID}`);
            return;
        }

        const mention = ROLE_ID ? `<@&${ROLE_ID}> ` : '';
        await channel.send({
            content: `🔔 ${mention}Roblox vừa có bản cập nhật mới!`,
            embeds: [buildUpdateEmbed(updates)],
        });

        const names = updates.map((u) => `${u.platform} → ${u.newVer}`).join(' | ');
        log('update', `Đã gửi thông báo! ${names}`);

        saveVersions(savedData);
    } catch (err) {
        log('error', `Gửi thông báo Discord thất bại: ${err.message}`);
    }
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────
client.once('ready', async () => {
    log('success', `Bot đã đăng nhập: ${client.user.tag}`);
    log('info',    `Kiểm tra mỗi ${CHECK_INTERVAL / 60_000} phút | Kênh: ${CHANNEL_ID}`);

    client.user.setActivity('Roblox updates 👀', { type: ActivityType.Watching });

    // Gửi thông báo bot đã online lên kênh
    try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        if (channel) {
            await channel.send({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('🤖 Bot đã khởi động!')
                        .setDescription(
                            `Đang theo dõi phiên bản Roblox trên **${PLATFORMS.join(', ')}**.\n` +
                            `Kiểm tra mỗi **${CHECK_INTERVAL / 60_000} phút** một lần.`
                        )
                        .setColor(0x57f287)
                        .setTimestamp()
                        .setFooter({ text: 'WEAO Version Tracker • weao.xyz' }),
                ],
            });
        }
    } catch (err) {
        log('warn', `Không gửi được startup message: ${err.message}`);
    }

    // Chạy lần đầu ngay, sau đó theo interval
    await checkRobloxUpdates();
    setInterval(checkRobloxUpdates, CHECK_INTERVAL);
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
process.on('SIGINT', () => {
    log('info', 'Đang tắt bot...');
    client.destroy();
    process.exit(0);
});

process.on('unhandledRejection', (err) => {
    log('error', `Unhandled rejection: ${err.message}`);
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────
if (!TOKEN || !CHANNEL_ID) {
    console.error('❌ Thiếu DISCORD_TOKEN hoặc CHANNEL_ID trong file .env!');
    process.exit(1);
}

client.login(TOKEN);
