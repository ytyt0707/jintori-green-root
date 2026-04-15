/**
 * modules/stats.js
 * 統計情報の収集・出力・DB保存
 */

const os = require('os');

// 依存モジュール（後でsetupで注入）
let config, state, bandwidthStats, dbPool;

// ============================================================
// ユーティリティ関数
// ============================================================
function formatBytes(bytes) {
    if (bytes < 1024) return bytes.toFixed(0) + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function formatTime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}時間${m}分${s}秒`;
    return `${m}分${s}秒`;
}

// ============================================================
// ラウンド統計リセット
// ============================================================
function resetRoundStats() {
    bandwidthStats.periodBytesSent = 0;
    bandwidthStats.periodBytesReceived = 0;
    bandwidthStats.periodMsgsSent = 0;
    bandwidthStats.periodMsgsReceived = 0;
    bandwidthStats.periodFullSyncs = 0;
    bandwidthStats.periodDeltaSyncs = 0;
    bandwidthStats.lastSampleOriginal = 0;
    bandwidthStats.lastSampleCompressed = 0;
    bandwidthStats.periodStart = Date.now();

    // CPU & Lag Stats
    bandwidthStats.cpuUserStart = process.cpuUsage().user;
    bandwidthStats.cpuSystemStart = process.cpuUsage().system;
    bandwidthStats.lagSum = 0;
    bandwidthStats.lagMax = 0;
    bandwidthStats.ticks = 0;

    // 送信内訳リセット
    bandwidthStats.breakdown = {
        players: 0,
        territoryFull: 0,
        territoryDelta: 0,
        minimap: 0,
        teams: 0,
        base: 0,
        other: 0
    };

    // 受信内訳リセット
    bandwidthStats.received = {
        input: 0,
        join: 0,
        chat: 0,
        updateTeam: 0,
        ping: 0,
        other: 0
    };
}

// ============================================================
// 統計情報をDBに保存
// ============================================================
async function saveStatsToDB(mode, stats) {
    if (!dbPool) {
        console.log('[DB] saveStatsToDB: No DB pool, skipping');
        return;
    }

    // 値の検証とデフォルト値設定
    const safeNum = (v, def = 0) => (typeof v === 'number' && !isNaN(v) ? v : def);
    const safeStr = (v, def = '') => (typeof v === 'string' ? v : def);

    const values = [
        safeStr(mode, 'UNKNOWN'),
        safeNum(stats.roundDurationSec),
        safeNum(stats.playerCount),
        safeNum(stats.activePlayerCount),
        safeNum(stats.territoryRects),
        safeNum(stats.territoryVersion),
        safeNum(stats.bytesSent),
        safeNum(stats.bytesReceived),
        safeNum(stats.sendRateBps),
        safeNum(stats.recvRateBps),
        safeNum(stats.perPlayerSent),
        safeNum(stats.avgMsgSize),
        safeNum(stats.fullSyncs),
        safeNum(stats.deltaSyncs),
        safeNum(stats.cpuPercent),
        safeNum(stats.loadAvg1m),
        safeNum(stats.avgLagMs),
        safeNum(stats.maxLagMs),
        safeNum(stats.breakdown?.players),
        safeNum(stats.breakdown?.territoryFull),
        safeNum(stats.breakdown?.territoryDelta),
        safeNum(stats.breakdown?.minimap),
        safeNum(stats.breakdown?.teams),
        safeNum(stats.breakdown?.base),
        // Node.jsプロセスのメモリ
        safeNum(stats.memoryMB?.heapUsed),
        safeNum(stats.memoryMB?.heapTotal),
        safeNum(stats.memoryMB?.rss),
        safeNum(stats.memoryMB?.external),
        // システムメモリ
        safeNum(stats.systemMemory?.totalMB),
        safeNum(stats.systemMemory?.usedMB),
        safeNum(stats.systemMemory?.usagePercent)
    ];

    let conn;
    try {
        conn = await dbPool.getConnection();
        await conn.execute(
            `INSERT INTO round_stats (
                mode, round_duration_sec, player_count, active_player_count,
                territory_rects, territory_version,
                bytes_sent, bytes_received, send_rate_bps, recv_rate_bps,
                per_player_sent, avg_msg_size, full_syncs, delta_syncs,
                cpu_percent, load_avg_1m, avg_lag_ms, max_lag_ms,
                breakdown_players, breakdown_territory_full, breakdown_territory_delta,
                breakdown_minimap, breakdown_teams, breakdown_base,
                heap_used_mb, heap_total_mb, rss_mb, external_mb,
                system_mem_total_mb, system_mem_used_mb, system_mem_usage_pct
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            values
        );
        console.log('[DB] Saved round stats');
    } catch (e) {
        console.error('[DB] Failed to save stats:', e.message);
        console.error('[DB] Values:', JSON.stringify(values));
    } finally {
        if (conn) conn.release();
    }
}

// ============================================================
// ラウンド統計を出力＆DB保存
// ============================================================
function printRoundStats(serverStartTime, currentModeIdx) {
    const now = Date.now();
    const roundDuration = (now - bandwidthStats.periodStart) / 1000;
    const playerCount = Object.keys(state.players).length;
    const activePlayerCount = Object.values(state.players).filter(p => p.state !== 'waiting').length;
    const uptimeSec = Math.floor((now - serverStartTime) / 1000);
    const mode = config.GAME_MODES[currentModeIdx];

    // CPU使用率計算
    const cpuUsage = process.cpuUsage();
    const elapsed = now - bandwidthStats.periodStart;
    const cpuPercent = elapsed > 0 ?
        ((cpuUsage.user - bandwidthStats.cpuUserStart + cpuUsage.system - bandwidthStats.cpuSystemStart) / (elapsed * 1000) * 100) : 0;

    // 平均ラグ
    const avgLag = bandwidthStats.ticks > 0 ? (bandwidthStats.lagSum / bandwidthStats.ticks).toFixed(1) : '0.0';
    const maxLag = bandwidthStats.lagMax.toFixed(1);

    // LoadAverage
    const loadAvgStr = os.loadavg()[0].toFixed(2);

    // メモリ使用量
    const memUsage = process.memoryUsage();
    const heapUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(1);
    const heapTotalMB = (memUsage.heapTotal / 1024 / 1024).toFixed(1);
    const rssMB = (memUsage.rss / 1024 / 1024).toFixed(1);
    const externalMB = (memUsage.external / 1024 / 1024).toFixed(1);

    // システムメモリ使用率
    const systemMemTotalMB = os.totalmem() / 1024 / 1024;
    const systemMemFreeMB = os.freemem() / 1024 / 1024;
    const systemMemUsedMB = systemMemTotalMB - systemMemFreeMB;
    const systemMemUsagePct = (systemMemUsedMB / systemMemTotalMB) * 100;

    // 転送レート計算
    const sendRate = roundDuration > 0 ? bandwidthStats.periodBytesSent / roundDuration : 0;
    const recvRate = roundDuration > 0 ? bandwidthStats.periodBytesReceived / roundDuration : 0;
    const perPlayerSent = playerCount > 0 ? bandwidthStats.periodBytesSent / playerCount : 0;
    const perPlayerRate = playerCount > 0 && roundDuration > 0 ? perPlayerSent / roundDuration : 0;
    const avgMsgSize = bandwidthStats.periodMsgsSent > 0 ? bandwidthStats.periodBytesSent / bandwidthStats.periodMsgsSent : 0;

    // 内訳
    const bd = bandwidthStats.breakdown;
    const rv = bandwidthStats.received;
    const totalBreakdown = bd.players + bd.territoryFull + bd.territoryDelta + bd.minimap + bd.teams + bd.base + bd.other;
    const totalReceived = rv.input + rv.join + rv.chat + rv.updateTeam + rv.other;

    const calcPercent = (val) => totalBreakdown > 0 ? ((val / totalBreakdown) * 100).toFixed(1) : '0.0';
    const calcRecvPercent = (val) => totalReceived > 0 ? ((val / totalReceived) * 100).toFixed(1) : '0.0';

    // 圧縮効果
    let compressionInfo = 'N/A';
    if (bandwidthStats.lastSampleOriginal > 0 && bandwidthStats.lastSampleCompressed > 0) {
        const ratio = ((1 - bandwidthStats.lastSampleCompressed / bandwidthStats.lastSampleOriginal) * 100).toFixed(1);
        compressionInfo = `${formatBytes(bandwidthStats.lastSampleOriginal)} → ${formatBytes(bandwidthStats.lastSampleCompressed)} (${ratio}%削減)`;
    }

    // 予測 (現在のレートが続いた場合)
    const dailySend = sendRate * 86400;
    const monthlySend = dailySend * 30;

    // 統計データオブジェクト (DB保存用)
    const stats = {
        roundDurationSec: Math.round(roundDuration),
        playerCount,
        activePlayerCount,
        territoryRects: state.territoryRects.length,
        territoryVersion: state.territoryVersion,
        bytesSent: bandwidthStats.periodBytesSent,
        bytesReceived: bandwidthStats.periodBytesReceived,
        sendRateBps: Math.round(sendRate),
        recvRateBps: Math.round(recvRate),
        perPlayerSent: Math.round(perPlayerSent),
        avgMsgSize: Math.round(avgMsgSize),
        fullSyncs: bandwidthStats.periodFullSyncs,
        deltaSyncs: bandwidthStats.periodDeltaSyncs,
        cpuPercent: parseFloat(cpuPercent.toFixed(1)),
        loadAvg1m: os.loadavg()[0],
        avgLagMs: parseFloat(avgLag),
        maxLagMs: bandwidthStats.lagMax,
        breakdown: { ...bandwidthStats.breakdown },
        // メモリ使用量
        memoryMB: {
            heapUsed: parseFloat(heapUsedMB),
            heapTotal: parseFloat(heapTotalMB),
            rss: parseFloat(rssMB),
            external: parseFloat(externalMB)
        },
        // システムメモリ
        systemMemory: {
            totalMB: parseFloat(systemMemTotalMB.toFixed(0)),
            usedMB: parseFloat(systemMemUsedMB.toFixed(0)),
            usagePercent: parseFloat(systemMemUsagePct.toFixed(1))
        }
    };

    // === 詳細レポート出力 ===
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                📊 ラウンド終了 - 転送量＆負荷統計レポート                     ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log('║ ⚡ 実装中の負荷対策: [MsgPack] [AOI(Distance)] [Minimap Bitmap] [Binary tb]  ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log(`║ 🕐 稼働: ${formatTime(uptimeSec).padEnd(15)} | ラウンド: ${formatTime(Math.round(roundDuration))}`);
    console.log(`║ 💻 CPU使用率: ${cpuPercent.toFixed(1)}% | LA(1m): ${loadAvgStr} | 平均ラグ: ${avgLag}ms (Max: ${maxLag}ms)`);
    console.log(`║ 🧠 メモリ: Heap ${heapUsedMB}/${heapTotalMB} MB | RSS ${rssMB} MB | External ${externalMB} MB`);
    console.log(`║ 🎮 モード: ${mode.padEnd(10)} | 接続数: ${playerCount}人 (アクティブ: ${activePlayerCount}人)`);
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log(`║ 🗺️  テリトリー数: ${state.territoryRects.length} rect | バージョン: ${state.territoryVersion}`);
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log(`║ 📡 ラウンド送信 (サーバ→クライアント): ${formatBytes(bandwidthStats.periodBytesSent).padEnd(10)} (${formatBytes(sendRate)}/s)`);
    console.log(`║ 📥 ラウンド受信 (クライアント→サーバ): ${formatBytes(bandwidthStats.periodBytesReceived).padEnd(10)} (${formatBytes(recvRate)}/s)`);
    console.log(`║ 👤 1人あたり送信: ${formatBytes(perPlayerSent).padEnd(10)}  (${formatBytes(perPlayerRate)}/s)`);
    console.log(`║ 📦 平均メッセージサイズ: ${formatBytes(avgMsgSize)}`);
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log('║ 📊 【送信内訳 (サンプリング値, Server→Client)】                              ║');
    console.log(`║   👥 プレイヤーデータ (p):  ${formatBytes(bd.players).padEnd(10)} ${calcPercent(bd.players).padStart(5)}%`);
    console.log(`║   🗺️  テリトリー全量 (tf): ${formatBytes(bd.territoryFull).padEnd(10)} ${calcPercent(bd.territoryFull).padStart(5)}%`);
    console.log(`║   📝 テリトリー差分 (td): ${formatBytes(bd.territoryDelta).padEnd(10)} ${calcPercent(bd.territoryDelta).padStart(5)}%`);
    console.log(`║   🔍 ミニマップ (mm):      ${formatBytes(bd.minimap).padEnd(10)} ${calcPercent(bd.minimap).padStart(5)}%`);
    console.log(`║   👯 チーム統計 (te):      ${formatBytes(bd.teams).padEnd(10)} ${calcPercent(bd.teams).padStart(5)}%`);
    console.log(`║   🏷️  ベース情報:          ${formatBytes(bd.base).padEnd(10)} ${calcPercent(bd.base).padStart(5)}%`);
    console.log(`║   📦 その他:              ${formatBytes(bd.other).padEnd(10)} ${calcPercent(bd.other).padStart(5)}%`);
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log('║ 📥 【受信内訳 (Client→Server)】                                              ║');
    console.log(`║   🎮 移動入力:    ${formatBytes(rv.input).padEnd(10)} ${calcRecvPercent(rv.input).padStart(5)}%`);
    console.log(`║   🚀 参加:        ${formatBytes(rv.join).padEnd(10)} ${calcRecvPercent(rv.join).padStart(5)}%`);
    console.log(`║   💬 チャット:    ${formatBytes(rv.chat).padEnd(10)} ${calcRecvPercent(rv.chat).padStart(5)}%`);
    console.log(`║   🏷️  チーム変更:  ${formatBytes(rv.updateTeam).padEnd(10)} ${calcRecvPercent(rv.updateTeam).padStart(5)}%`);
    console.log(`║   📦 その他:      ${formatBytes(rv.other).padEnd(10)} ${calcRecvPercent(rv.other).padStart(5)}%`);
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log(`║ 🔄 同期回数: フル ${bandwidthStats.periodFullSyncs} | 差分 ${bandwidthStats.periodDeltaSyncs}`);
    console.log(`║ 🗜️  gzip圧縮効果: ${compressionInfo}`);
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log(`║ 📊 [累計] 送信(→クライアント): ${formatBytes(bandwidthStats.totalBytesSent).padEnd(10)} | 受信(←クライアント): ${formatBytes(bandwidthStats.totalBytesReceived || 0)}`);
    console.log(`║ 🔮 [予測] このペースで1日: ${formatBytes(dailySend).padEnd(8)} | 1月: ${formatBytes(monthlySend)}`);
    console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
    console.log('');

    // STATS_MODEの時はJSON形式も出力
    if (config.STATS_MODE) {
        console.log(`[STATS_JSON]${JSON.stringify(stats)}`);
    }

    // DBに保存
    saveStatsToDB(mode, stats).catch(e => console.error('[DB] saveStatsToDB uncaught error:', e));
}

// ============================================================
// セットアップ
// ============================================================
function setup(dependencies) {
    config = dependencies.config;
    state = dependencies.state;
    bandwidthStats = dependencies.bandwidthStats;
    dbPool = dependencies.dbPool;
}

module.exports = {
    setup,
    resetRoundStats,
    printRoundStats,
    saveStatsToDB,
    formatBytes,
    formatTime
};
