// bot.js
require('dotenv').config();
const fs = require('fs');
const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ─── 상태 관리 ─────────────────────────────────────────────────────────────────
const state = {
  captains: {},
  items: [],
  auction: null,
  phase: 'idle',
  auctionQueue: [],
  queueIndex: 0,
  round: 1,
  paused: false,
  snapshot: null,
  lastAuctionSnapshot: null,
  timeoutUsed: new Set(),
  auctionManagerRoleId: null
};

const PREFIX = '!';
const BASE_TIME = 30;
const BID_EXTEND = 3;
const MIN_BID = 5;
const SAVE_FILE = './data.json';

// ─── 저장/불러오기 ─────────────────────────────────────────────────────────────
function saveData() {
  const data = {
    captains:             state.captains,
    items:                state.items,
    auctionQueue:         state.auctionQueue,
    queueIndex:           state.queueIndex,
    round:                state.round,
    snapshot:             state.snapshot,
    auctionManagerRoleId: state.auctionManagerRoleId
  };
  fs.writeFileSync(SAVE_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function loadData() {
  if (!fs.existsSync(SAVE_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf-8'));
    state.captains             = data.captains             || {};
    state.items                = data.items                || [];
    state.auctionQueue         = data.auctionQueue         || [];
    state.queueIndex           = data.queueIndex           || 0;
    state.round                = data.round                || 1;
    state.snapshot             = data.snapshot             || null;
    state.auctionManagerRoleId = data.auctionManagerRoleId || null;
    console.log(
      '📂 데이터 불러오기 완료 — ' +
      '캡틴 ' + Object.keys(state.captains).length + '명, ' +
      '매물 ' + state.items.length + '개'
    );
  } catch (e) {
    console.error('데이터 불러오기 실패:', e);
  }
}

// ─── 권한 체크 ─────────────────────────────────────────────────────────────────
function isAdmin(msg) {
  if (msg.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (state.auctionManagerRoleId && msg.member.roles.cache.has(state.auctionManagerRoleId)) return true;
  return false;
}

// ─── 유틸 ──────────────────────────────────────────────────────────────────────
function shuffleArr(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sortedCaptains() {
  return Object.entries(state.captains).sort((a, b) => b[1].points - a[1].points);
}

function timerBar(timeLeft, total = BASE_TIME) {
  const filled = Math.round((timeLeft / total) * 10);
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, 10 - filled));
}

// ─── 경매 Embed ────────────────────────────────────────────────────────────────
function buildAuctionEmbed() {
  const { item, currentBid, bidder, timeLeft } = state.auction;
  const urgent = timeLeft <= 5;
  const color = state.paused
    ? 0xaaaaaa
    : urgent ? 0xff4444
    : timeLeft <= 10 ? 0xffa500
    : 0x00b4d8;

  const rankText    = item.rank    ? '#' + item.rank.toLocaleString() : '미입력';
  const commentText = item.comment ? item.comment                     : '없음';

  return new EmbedBuilder()
    .setTitle((state.paused ? '⏸' : '🔨') + '  [' + state.round + '차] ' + item.name)
    .setColor(color)
    .addFields(
      { name: '🌐 osu 랭킹', value: rankText,    inline: true },
      { name: '💬 코멘트',   value: commentText, inline: true },
      { name: '\u200B',      value: '\u200B',    inline: false },
      {
        name: '💰 현재 최고 입찰',
        value: bidder
          ? '**' + currentBid + 'pt** — <@' + bidder + '> (' + (state.captains[bidder]?.name) + ')'
          : '`아직 없음`',
        inline: false
      },
      {
        name: '⏱ 남은 시간  ' + timerBar(timeLeft),
        value: '**' + timeLeft + '초**' + (state.paused ? '  ⏸ 일시정지 중' : urgent ? '  🚨 마감 임박!' : ''),
        inline: false
      },
      {
        name: '📋 캡틴 포인트 현황',
        value: sortedCaptains().map(([, c]) => c.name + ': **' + c.points + 'pt**').join('  |  '),
        inline: false
      }
    )
    .setFooter({ text: '!bid <금액> 으로 입찰 (최소 ' + MIN_BID + 'pt) | ' + state.round + '차 경매' });
}

async function updateAuctionMessage() {
  if (!state.auction) return;
  try {
    const msg = await state.auction.channel.messages.fetch(state.auction.messageId);
    await msg.edit({ embeds: [buildAuctionEmbed()] });
  } catch (_) {}
}

// ─── 경매 종료 처리 ────────────────────────────────────────────────────────────
async function endCurrentAuction() {
  if (!state.auction) return;
  clearInterval(state.auction.timerInterval);

  const { item, currentBid, bidder, channel } = state.auction;

  state.lastAuctionSnapshot = {
    item:         JSON.parse(JSON.stringify(item)),
    captains:     JSON.parse(JSON.stringify(state.captains)),
    auctionQueue: [...state.auctionQueue],
    queueIndex:   state.queueIndex,
    round:        state.round
  };

  state.auction = null;
  state.phase   = 'idle';

  if (bidder) {
    const captain = state.captains[bidder];
    captain.points -= currentBid;
    captain.team.push(item.name);
    item.status = 'sold';

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('🎉 낙찰!  ' + item.name)
          .setColor(0x2ecc71)
          .setDescription(
            '**' + captain.name + '** 낙찰\n' +
            '차감: **' + currentBid + 'pt** → 잔여: **' + captain.points + 'pt**'
          )
      ]
    });
  } else {
    if (state.round === 1) {
      item.status = 'failed1';
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('⚠️ 1차 유찰  —  ' + item.name)
            .setColor(0xe67e22)
            .setDescription('2차 경매에서 다시 진행됩니다.')
        ]
      });
    } else {
      item.status = 'failed';
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ 최종 유찰  —  ' + item.name)
            .setColor(0x888888)
            .setDescription('드래프트 대상 매물로 등록됩니다.')
        ]
      });
    }
  }

  if (state.paused) {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('⏸ 일시정지 중')
          .setColor(0xaaaaaa)
          .setDescription('`!resume` 으로 다음 경매를 재개하세요.')
      ]
    });
    return;
  }

  await runNextAuction(channel);
}

// ─── 다음 경매 진행 ────────────────────────────────────────────────────────────
async function runNextAuction(channel) {
  if (state.phase !== 'idle') return;
  if (state.paused) return;

  while (state.queueIndex < state.auctionQueue.length) {
    const nextId = state.auctionQueue[state.queueIndex];
    state.queueIndex++;
    const item = state.items.find(i => i.id === nextId);
    const targetStatus = state.round === 1 ? 'pending' : 'failed1';
    if (item && item.status === targetStatus) {
      await startAuctionItem(item, channel);
      return;
    }
  }

  if (state.round === 1) {
    const failed1 = state.items.filter(i => i.status === 'failed1');

    if (failed1.length === 0) {
      await announceResults(channel);
      return;
    }

    state.round        = 2;
    state.auctionQueue = shuffleArr(failed1.map(i => i.id));
    state.queueIndex   = 0;

    const orderText = state.auctionQueue
      .map((id, idx) => {
        const it          = state.items.find(i => i.id === id);
        const rankText    = it.rank    ? ' | 🌐 #' + it.rank.toLocaleString() : '';
        const commentText = it.comment ? ' | 💬 ' + it.comment                : '';
        return '**' + (idx + 1) + '.** ' + it.name + rankText + commentText;
      })
      .join('\n');

    const captainMentions = Object.keys(state.captains).map(id => '<@' + id + '>').join(' ');

    await channel.send({
      content: captainMentions,
      embeds: [
        new EmbedBuilder()
          .setTitle('🔁 2차 경매 순서 (재셔플)')
          .setColor(0xe67e22)
          .setDescription(orderText)
          .addFields(
            { name: '📋 총 매물 수', value: state.auctionQueue.length + '개', inline: true },
            { name: '👑 참여 캡틴',  value: Object.values(state.captains).map(c => c.name).join(', '), inline: true }
          )
          .setFooter({ text: '5초 후 2차 경매 시작!' })
      ]
    });

    setTimeout(() => runNextAuction(channel), 5000);

  } else {
    await announceResults(channel);
  }
}

// ─── 경매 아이템 시작 ──────────────────────────────────────────────────────────
async function startAuctionItem(item, channel) {

  const activeCaptains = Object.entries(state.captains).filter(([, c]) => c.points > 0);
  if (activeCaptains.length <= 1) {
    state.phase = 'idle';

    const remainingIds = state.auctionQueue.slice(state.queueIndex - 1);
    for (const id of remainingIds) {
      const remainItem = state.items.find(i => i.id === id);
      if (!remainItem) continue;
      const targetStatus = state.round === 1 ? 'pending' : 'failed1';
      if (remainItem.status === targetStatus) {
        remainItem.status = state.round === 1 ? 'failed1' : 'failed';
      }
    }
    item.status = state.round === 1 ? 'failed1' : 'failed';

    const failedItems = state.items.filter(i => i.status === 'failed1' || i.status === 'failed');
    const failedText  = failedItems.length > 0
      ? failedItems.map(i => {
          const tag = i.status === 'failed' ? '❌ 최종' : '⚠️ 1차';
          return tag + ' | ' + i.name + (i.rank ? ' | 🌐 #' + i.rank.toLocaleString() : '');
        }).join('\n')
      : '없음';

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('🚨 경매 자동 종료')
          .setColor(0xe74c3c)
          .setDescription(
            '입찰 가능한 캡틴이 1명 이하로 남은 경매를 진행할 수 없습니다.\n' +
            '남은 매물이 모두 유찰 처리됩니다.'
          )
          .addFields({ name: '❌ 유찰 매물 목록', value: failedText, inline: false })
      ]
    });

    await announceResults(channel);
    return;
  }

  state.phase = 'auction';

  const rankText    = item.rank    ? '#' + item.rank.toLocaleString() : '미입력';
  const commentText = item.comment ? item.comment                     : '없음';

  const sentMsg = await channel.send({
    content: '@here  ⚡ ' + state.round + '차 경매 시작!',
    embeds: [
      new EmbedBuilder()
        .setTitle('🔨  [' + state.round + '차] ' + item.name)
        .setColor(0x00b4d8)
        .addFields(
          { name: '🌐 osu 랭킹', value: rankText,    inline: true },
          { name: '💬 코멘트',   value: commentText, inline: true }
        )
        .setDescription('\n경매가 곧 시작됩니다...')
    ]
  });

  state.auction = {
    item,
    currentBid: 0,
    bidder:     null,
    timeLeft:   BASE_TIME,
    timerInterval: null,
    channel,
    messageId:  sentMsg.id
  };

  state.auction.timerInterval = setInterval(async () => {
    if (!state.auction) return;
    if (state.paused) return;

    state.auction.timeLeft -= 1;

    const t = state.auction.timeLeft;
    if (t <= 10 || t % 5 === 0) {
      await updateAuctionMessage();
    }

    if (t <= 0) {
      await endCurrentAuction();
    }
  }, 1000);
}

// ─── 최종 결과 출력 ────────────────────────────────────────────────────────────
async function announceResults(channel) {
  const failed = state.items.filter(i => i.status === 'failed');

  const embed = new EmbedBuilder()
    .setTitle('🏁 전체 경매 종료!')
    .setColor(0x9b59b6);

  const soldText = sortedCaptains()
    .map(([, c]) => {
      const picks = c.team.length > 0 ? c.team.join(', ') : '없음';
      return '**' + c.name + '** (잔여 ' + c.points + 'pt)\n→ ' + picks;
    })
    .join('\n\n');

  const pointsText = sortedCaptains()
    .map(([, c], idx) => {
      const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : (idx + 1) + '.';
      const spent = 1000 - c.points;
      return medal + ' **' + c.name + '** — 잔여 **' + c.points + 'pt** (사용 ' + spent + 'pt)';
    })
    .join('\n');

  embed.addFields(
    { name: '✅ 낙찰 결과',        value: soldText   || '없음', inline: false },
    { name: '💰 최종 포인트 현황', value: pointsText || '없음', inline: false },
    {
      name: '❌ 최종 유찰 매물 (드래프트 대상)',
      value: failed.length > 0 ? failed.map(i => '• ' + i.name).join('\n') : '없음',
      inline: false
    }
  );

  await channel.send({ embeds: [embed] });
}

// ─── 커맨드 ────────────────────────────────────────────────────────────────────
const commands = {

  async register_captain(msg, args) {
    if (!isAdmin(msg)) return msg.reply('관리자만 사용 가능합니다.');
    const mention = msg.mentions.users.first();
    const name    = args.slice(1).join(' ');
    if (!mention || !name) return msg.reply('사용법: `!register_captain @유저 이름`');
    if (state.captains[mention.id]) return msg.reply('이미 등록된 캡틴입니다.');
    state.captains[mention.id] = { name, points: 1000, team: [] };
    msg.channel.send('✅ **' + name + '** 캡틴 등록 완료! (1000pt)');
    saveData();
  },

  async add_item(msg, args) {
    if (!isAdmin(msg)) return msg.reply('관리자만 사용 가능합니다.');
    const input = args.join(' ');
    const parts = input.split('/').map(s => s.trim());
    if (!parts[0]) return msg.reply(
      '사용법: `!add_item 선수이름 / osu랭킹 / 코멘트`\n' +
      '예시: `!add_item 홍길동 / 15420 / 고BPM 강점`\n' +
      '※ 랭킹과 코멘트는 생략 가능'
    );

    const name    = parts[0];
    const rank    = parts[1] ? parseInt(parts[1]) : null;
    const comment = parts[2] || null;
    if (parts[1] && isNaN(rank)) return msg.reply('랭킹은 숫자로 입력해주세요.');

    const id = state.items.length + 1;
    state.items.push({ id, name, rank, comment, failCount: 0, status: 'pending' });

    const rankText    = rank    ? '#' + rank.toLocaleString() : '미입력';
    const commentText = comment ? comment                     : '없음';
    msg.channel.send(
      '📋 매물 등록: **[' + id + '] ' + name + '**\n' +
      '> 🌐 osu 랭킹: **' + rankText + '**\n' +
      '> 💬 코멘트: ' + commentText
    );
    saveData();
  },

  async edit_item(msg, args) {
    if (!isAdmin(msg)) return msg.reply('관리자만 사용 가능합니다.');
    const input    = args.join(' ');
    const spaceIdx = input.indexOf(' ');
    if (spaceIdx === -1) return msg.reply(
      '사용법: `!edit_item <ID> 이름 / 랭킹 / 코멘트`\n' +
      '예시: `!edit_item 3 홍길동 / 15420 / 고BPM 강점`'
    );

    const id   = parseInt(input.slice(0, spaceIdx));
    const rest = input.slice(spaceIdx + 1).trim();
    if (isNaN(id)) return msg.reply('ID는 숫자로 입력해주세요.');

    const item = state.items.find(i => i.id === id);
    if (!item) return msg.reply('ID ' + id + '번 매물을 찾을 수 없습니다.');
    if (state.auction?.item.id === id) return msg.reply('현재 경매 진행 중인 매물은 수정할 수 없습니다.');

    const parts      = rest.split('/').map(s => s.trim());
    const newName    = parts[0]               || item.name;
    const newRank    = parts[1] ? parseInt(parts[1]) : item.rank;
    const newComment = parts[2] !== undefined ? parts[2] : item.comment;
    if (parts[1] && isNaN(newRank)) return msg.reply('랭킹은 숫자로 입력해주세요.');

    const oldName    = item.name;
    const oldRank    = item.rank;
    const oldComment = item.comment;

    item.name    = newName;
    item.rank    = newRank;
    item.comment = newComment || null;

    const rankText       = item.rank    ? '#' + item.rank.toLocaleString() : '미입력';
    const commentText    = item.comment ? item.comment                     : '없음';
    const oldRankText    = oldRank      ? '#' + oldRank.toLocaleString()   : '미입력';
    const oldCommentText = oldComment   ? oldComment                       : '없음';

    await msg.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('✏️ 매물 수정 완료 — [' + id + '] ' + item.name)
          .setColor(0x3498db)
          .addFields(
            { name: '이름',        value: '~~' + oldName        + '~~ → **' + item.name   + '**', inline: false },
            { name: '🌐 osu 랭킹', value: '~~' + oldRankText    + '~~ → **' + rankText    + '**', inline: true  },
            { name: '💬 코멘트',   value: '~~' + oldCommentText + '~~ → **' + commentText + '**', inline: true  }
          )
      ]
    });
    saveData();
  },

  async set_manager_role(msg, args) {
    if (!msg.member.permissions.has(PermissionFlagsBits.Administrator))
      return msg.reply('서버 관리자만 사용 가능합니다.');
    const role = msg.mentions.roles.first();
    if (!role) return msg.reply('사용법: `!set_manager_role @역할`');
    state.auctionManagerRoleId = role.id;
    msg.channel.send('✅ **' + role.name + '** 역할이 경매 관리자로 설정되었습니다.');
    saveData();
  },

  async shuffle(msg) {
    if (!isAdmin(msg)) return msg.reply('관리자만 사용 가능합니다.');
    if (state.phase !== 'idle') return msg.reply('이미 경매가 진행 중입니다.');
    if (state.items.filter(i => i.status === 'pending').length === 0) return msg.reply('등록된 매물이 없습니다.');
    if (Object.keys(state.captains).length === 0) return msg.reply('등록된 캡틴이 없습니다.');

    state.round        = 1;
    const pendingIds   = state.items.filter(i => i.status === 'pending').map(i => i.id);
    state.auctionQueue = shuffleArr(pendingIds);
    state.queueIndex   = 0;
    state.snapshot     = {
      captains: JSON.parse(JSON.stringify(state.captains)),
      items:    JSON.parse(JSON.stringify(state.items)),
      round:    1
    };

    const orderText = state.auctionQueue
      .map((id, idx) => {
        const it          = state.items.find(i => i.id === id);
        const rankText    = it.rank    ? ' | 🌐 #' + it.rank.toLocaleString() : '';
        const commentText = it.comment ? ' | 💬 ' + it.comment                : '';
        return '**' + (idx + 1) + '.** ' + it.name + rankText + commentText;
      })
      .join('\n');

    const captainMentions = Object.keys(state.captains).map(id => '<@' + id + '>').join(' ');

    await msg.channel.send({
      content: captainMentions,
      embeds: [
        new EmbedBuilder()
          .setTitle('🎲 1차 경매 순서 추첨 결과')
          .setColor(0x3498db)
          .setDescription(orderText)
          .addFields(
            { name: '📋 총 매물 수', value: state.auctionQueue.length + '개', inline: true },
            { name: '👑 참여 캡틴',  value: Object.values(state.captains).map(c => c.name).join(', '), inline: true }
          )
          .setFooter({ text: '!start 으로 경매를 시작하세요!' })
      ]
    });
    saveData();
  },

  async start(msg) {
    if (!isAdmin(msg)) return msg.reply('관리자만 사용 가능합니다.');
    if (state.phase !== 'idle') return msg.reply('이미 경매가 진행 중입니다.');
    if (state.auctionQueue.length === 0) return msg.reply('먼저 `!shuffle` 로 순서를 정해주세요.');

    await msg.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('⚡ 경매 시작!')
          .setColor(0x00b4d8)
          .setDescription('5초 후 첫 번째 매물 경매를 시작합니다.')
      ]
    });
    setTimeout(() => runNextAuction(msg.channel), 5000);
  },

  async shuffle_and_start(msg) {
    if (!isAdmin(msg)) return msg.reply('관리자만 사용 가능합니다.');
    if (state.phase !== 'idle') return msg.reply('이미 경매가 진행 중입니다.');
    if (state.items.filter(i => i.status === 'pending').length === 0) return msg.reply('등록된 매물이 없습니다.');
    if (Object.keys(state.captains).length === 0) return msg.reply('등록된 캡틴이 없습니다.');

    state.round        = 1;
    state.paused       = false;
    const pendingIds   = state.items.filter(i => i.status === 'pending').map(i => i.id);
    state.auctionQueue = shuffleArr(pendingIds);
    state.queueIndex   = 0;
    state.snapshot     = {
      captains: JSON.parse(JSON.stringify(state.captains)),
      items:    JSON.parse(JSON.stringify(state.items)),
      round:    1
    };

    const orderText = state.auctionQueue
      .map((id, idx) => {
        const it          = state.items.find(i => i.id === id);
        const rankText    = it.rank    ? ' | 🌐 #' + it.rank.toLocaleString() : '';
        const commentText = it.comment ? ' | 💬 ' + it.comment                : '';
        return '**' + (idx + 1) + '.** ' + it.name + rankText + commentText;
      })
      .join('\n');

    const captainMentions = Object.keys(state.captains).map(id => '<@' + id + '>').join(' ');

    await msg.channel.send({
      content: captainMentions,
      embeds: [
        new EmbedBuilder()
          .setTitle('🎲 1차 경매 순서 추첨 결과')
          .setColor(0x3498db)
          .setDescription(orderText)
          .addFields(
            { name: '📋 총 매물 수', value: state.auctionQueue.length + '개', inline: true },
            { name: '👑 참여 캡틴',  value: Object.values(state.captains).map(c => c.name).join(', '), inline: true }
          )
          .setFooter({ text: '5초 후 1차 경매 시작!' })
      ]
    });
    saveData();
    setTimeout(() => runNextAuction(msg.channel), 5000);
  },

  async bid(msg, args) {
    if (state.phase !== 'auction' || !state.auction) return;
    if (state.paused) return msg.reply('⏸ 일시정지 중에는 입찰할 수 없습니다.');

    const captain = state.captains[msg.author.id];
    if (!captain) return msg.reply('캡틴으로 등록되지 않았습니다.');

    const amount = parseInt(args[0]);
    if (isNaN(amount) || amount <= 0) return msg.reply('올바른 금액을 입력하세요.');
    if (amount < MIN_BID) return msg.reply('최소 입찰 금액은 **' + MIN_BID + 'pt** 입니다.');
    if (captain.points <= 0) return msg.reply('포인트가 없어 입찰할 수 없습니다. (보유: ' + captain.points + 'pt)');
    if (amount > captain.points) return msg.reply('포인트 부족 (보유: ' + captain.points + 'pt)');

    // ── 상위 입찰 최소 금액 체크 ──
    const currentBid = state.auction.currentBid;
    if (currentBid > 0) {
      let minRaise, ruleText;
      if (currentBid <= 50) {
        minRaise = 5;
        ruleText = '50pt 이하 구간: **+5pt 고정**';
      } else if (currentBid <= 500) {
        minRaise = Math.max(5, Math.ceil(currentBid * 0.05));
        ruleText = '51~500pt 구간: **5%** (최소 5pt)';
      } else {
        minRaise = Math.max(26, Math.ceil(currentBid * 0.1));
        ruleText = '501pt 이상 구간: **10%** (최소 26pt)';
      }
      const minNext = currentBid + minRaise;
      if (amount < minNext)
        return msg.reply(
          '현재 입찰: **' + currentBid + 'pt**\n' +
          ruleText + '\n' +
          '최소 입찰 가능 금액: **' + minNext + 'pt**'
        );
    }

    state.auction.currentBid = amount;
    state.auction.bidder     = msg.author.id;

    // ── 타이머 연장: 3초 이하면 5초 고정, 그 외 +3초 ──
    if (state.auction.timeLeft <= 3) {
      state.auction.timeLeft = 5;
    } else {
      state.auction.timeLeft += BID_EXTEND;
    }

    await updateAuctionMessage();
    await msg.react('✅');
  },

  async panic(msg) {
    const captain = state.captains[msg.author.id];
    if (!captain) return msg.reply('캡틴으로 등록되지 않았습니다.');
    if (state.phase !== 'auction') return msg.reply('경매가 진행 중이 아닙니다.');
    if (state.paused) return msg.reply('이미 일시정지 상태입니다.');

    state.paused = true;
    await updateAuctionMessage();

    const managerMention = state.auctionManagerRoleId
      ? '<@&' + state.auctionManagerRoleId + '>'
      : '@관리자';

    await msg.channel.send({
      content: managerMention,
      embeds: [
        new EmbedBuilder()
          .setTitle('🚨 PANIC — 경매 긴급 정지!')
          .setColor(0xff0000)
          .setDescription(
            '<@' + msg.author.id + '> (**' + captain.name + '**) 이(가) 긴급 정지를 요청했습니다.\n\n' +
            '경매가 일시정지되었습니다.\n' +
            '관리자가 확인 후 `!resume` 으로 재개해주세요.'
          )
      ]
    });
  },

  async timeout(msg) {
    const captain = state.captains[msg.author.id];
    if (!captain) return msg.reply('캡틴으로 등록되지 않았습니다.');
    if (state.phase !== 'auction') return msg.reply('경매가 진행 중이 아닙니다.');
    if (state.paused) return msg.reply('이미 일시정지 상태입니다.');
    if (state.timeoutUsed.has(msg.author.id))
      return msg.reply('타임아웃은 경매당 1회만 사용할 수 있습니다.');

    state.timeoutUsed.add(msg.author.id);
    state.paused = true;
    await updateAuctionMessage();

    await msg.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('⏱ 타임아웃!')
          .setColor(0xf39c12)
          .setDescription(
            '<@' + msg.author.id + '> (**' + captain.name + '**) 이(가) 타임아웃을 사용했습니다.\n' +
            '**30초** 후 경매가 자동으로 재개됩니다.'
          )
      ]
    });

    setTimeout(async () => {
      if (!state.paused) return;
      state.paused = false;

      const channel = state.auction ? state.auction.channel : msg.channel;

      if (state.phase === 'auction') {
        await updateAuctionMessage();
      }

      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('▶️ 타임아웃 종료 — 경매 재개')
            .setColor(0x2ecc71)
            .setDescription('30초 타임아웃이 종료되어 경매가 재개됩니다.')
        ]
      });

      if (state.phase === 'idle') {
        await runNextAuction(channel);
      }
    }, 30000);
  },

  async pause(msg) {
    if (!isAdmin(msg)) return msg.reply('관리자만 사용 가능합니다.');
    if (state.paused) return msg.reply('이미 일시정지 상태입니다.');

    state.paused = true;
    const desc = state.phase === 'auction'
      ? '현재 경매 타이머가 멈췄습니다.\n입찰 내역과 남은 시간은 그대로 유지됩니다.\n`!resume` 으로 재개하세요.'
      : '다음 경매 진행이 중단됩니다.\n`!resume` 으로 재개하세요.';

    if (state.phase === 'auction') await updateAuctionMessage();

    await msg.channel.send({
      embeds: [ new EmbedBuilder().setTitle('⏸ 일시정지').setColor(0xaaaaaa).setDescription(desc) ]
    });
  },

  async resume(msg) {
    if (!isAdmin(msg)) return msg.reply('관리자만 사용 가능합니다.');
    if (!state.paused) return msg.reply('일시정지 상태가 아닙니다.');

    state.paused = false;

    if (state.phase === 'auction') {
      await updateAuctionMessage();
      await msg.channel.send({
        embeds: [ new EmbedBuilder().setTitle('▶️ 경매 재개').setColor(0x2ecc71).setDescription('타이머가 재개됩니다.') ]
      });
    } else {
      await msg.channel.send({
        embeds: [ new EmbedBuilder().setTitle('▶️ 경매 재개').setColor(0x2ecc71).setDescription('5초 후 다음 매물 경매를 시작합니다.') ]
      });
      setTimeout(() => runNextAuction(msg.channel), 5000);
    }
  },

  async rollback_last(msg) {
    if (!isAdmin(msg)) return msg.reply('관리자만 사용 가능합니다.');
    if (!state.lastAuctionSnapshot) return msg.reply('되돌릴 수 있는 직전 경매가 없습니다.');
    if (state.phase === 'auction') return msg.reply('경매 진행 중에는 사용할 수 없습니다. `!pause` 후 사용하세요.');

    const snap = state.lastAuctionSnapshot;
    const item = state.items.find(i => i.id === snap.item.id);
    if (item) {
      item.status    = snap.item.status;
      item.failCount = snap.item.failCount;
    }

    for (const [id, cap] of Object.entries(snap.captains)) {
      if (state.captains[id]) {
        state.captains[id].points = cap.points;
        state.captains[id].team   = [...cap.team];
      }
    }

    state.auctionQueue        = [...snap.auctionQueue];
    state.queueIndex          = snap.queueIndex;
    state.round               = snap.round;
    state.lastAuctionSnapshot = null;

    await msg.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('↩️ 직전 경매 롤백 완료')
          .setColor(0xe74c3c)
          .setDescription(
            '**' + snap.item.name + '** 경매를 되돌렸습니다.\n' +
            '포인트와 낙찰/유찰 결과가 복구되었습니다.\n\n' +
            '`!resume` 으로 해당 매물부터 다시 진행됩니다.'
          )
      ]
    });
  },

  async rollback(msg) {
    if (!isAdmin(msg)) return msg.reply('관리자만 사용 가능합니다.');
    if (!state.snapshot) return msg.reply('저장된 스냅샷이 없습니다. (`!shuffle` 또는 `!shuffle_and_start` 이후에만 사용 가능)');

    if (state.auction?.timerInterval) {
      clearInterval(state.auction.timerInterval);
      state.auction = null;
    }

    state.captains     = JSON.parse(JSON.stringify(state.snapshot.captains));
    state.items        = JSON.parse(JSON.stringify(state.snapshot.items));
    state.round        = state.snapshot.round;
    state.phase        = 'idle';
    state.paused       = false;
    state.auctionQueue = [];
    state.queueIndex   = 0;
    state.timeoutUsed  = new Set();

    await msg.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('⏪ 원복 완료')
          .setColor(0xe74c3c)
          .setDescription(
            '경매 시작 직전 상태로 되돌렸습니다.\n' +
            '모든 포인트와 낙찰 결과가 초기화되었습니다.\n\n' +
            '`!shuffle` 또는 `!shuffle_and_start` 로 다시 시작하세요.'
          )
      ]
    });
  },

  async item_list(msg) {
    if (state.items.length === 0) return msg.reply('등록된 매물이 없습니다.');

    const statusLabel = { pending: '대기', failed1: '1차유찰', failed: '최종유찰', sold: '낙찰' };
    const text = state.items
      .map(i => {
        const rankText    = i.rank    ? '#' + i.rank.toLocaleString() : '-';
        const commentText = i.comment ? i.comment                     : '-';
        const status      = statusLabel[i.status] || i.status;
        return '**[' + i.id + '] ' + i.name + '** (' + status + ')\n> 🌐 ' + rankText + ' | 💬 ' + commentText;
      })
      .join('\n');

    msg.channel.send({
      embeds: [ new EmbedBuilder().setTitle('📋 전체 매물 목록').setColor(0x3498db).setDescription(text) ]
    });
  },

  async failed_list(msg) {
    const failed1 = state.items.filter(i => i.status === 'failed1');
    const failed  = state.items.filter(i => i.status === 'failed');

    const embed = new EmbedBuilder().setTitle('❌ 유찰 매물 현황').setColor(0x888888);
    embed.addFields(
      {
        name: '⚠️ 1차 유찰 (2차 경매 대기)',
        value: failed1.length > 0
          ? failed1.map(i => '• ' + i.name + (i.rank ? ' | 🌐 #' + i.rank.toLocaleString() : '')).join('\n')
          : '없음',
        inline: false
      },
      {
        name: '❌ 최종 유찰 (드래프트 대상)',
        value: failed.length > 0
          ? failed.map(i => '• ' + i.name + (i.rank ? ' | 🌐 #' + i.rank.toLocaleString() : '')).join('\n')
          : '없음',
        inline: false
      }
    );
    msg.channel.send({ embeds: [embed] });
  },

  async status(msg) {
    const embed = new EmbedBuilder()
      .setTitle('📊 현황 (현재 ' + state.round + '차 경매' + (state.paused ? ' | ⏸ 일시정지 중' : '') + ')')
      .setColor(0x5865f2);

    for (const [, cap] of sortedCaptains()) {
      embed.addFields({
        name:  cap.name + '  —  ' + cap.points + 'pt',
        value: cap.team.length > 0 ? cap.team.join(', ') : '낙찰 없음',
        inline: false
      });
    }

    const pending = state.items.filter(i => i.status === 'pending').length;
    const failed1 = state.items.filter(i => i.status === 'failed1').length;
    embed.setFooter({ text: '1차 대기: ' + pending + '개 | 1차 유찰(2차 대기): ' + failed1 + '개' });
    msg.channel.send({ embeds: [embed] });
  },

  async reset(msg) {
    if (!isAdmin(msg)) return msg.reply('관리자만 사용 가능합니다.');

    if (state.auction?.timerInterval) clearInterval(state.auction.timerInterval);

    state.captains            = {};
    state.items               = [];
    state.auction             = null;
    state.phase               = 'idle';
    state.auctionQueue        = [];
    state.queueIndex          = 0;
    state.round               = 1;
    state.paused              = false;
    state.snapshot            = null;
    state.lastAuctionSnapshot = null;
    state.timeoutUsed         = new Set();

    msg.channel.send('🔄 전체 초기화 완료.');
    saveData();
  },

  async help(msg) {
    const embed = new EmbedBuilder()
      .setTitle('📖 커맨드 목록')
      .setColor(0x5865f2)
      .addFields(
        {
          name: '⚙️ 준비',
          value:
            '`!register_captain @유저 이름` — 캡틴 등록 (1000pt)\n' +
            '`!add_item 이름 / 랭킹 / 코멘트` — 매물 등록 (랭킹·코멘트 생략 가능)\n' +
            '`!edit_item <ID> 이름 / 랭킹 / 코멘트` — 매물 수정\n' +
            '`!item_list` — 전체 매물 목록 확인',
          inline: false
        },
        {
          name: '🔨 경매',
          value:
            '`!shuffle` — 매물 셔플 후 순서 공지 (경매 시작 안 함)\n' +
            '`!start` — 셔플된 순서로 경매 시작\n' +
            '`!shuffle_and_start` — 셔플 + 경매 바로 시작\n' +
            '`!bid <금액>` — 입찰 (최소 5pt, 일시정지 중 불가)',
          inline: false
        },
        {
          name: '🆘 캡틴 전용',
          value:
            '`!panic` — 긴급 정지 요청 (관리자 멘션 + 자동 pause)\n' +
            '`!timeout` — 30초 타임아웃 (경매당 1회)',
          inline: false
        },
        {
          name: '📊 조회',
          value:
            '`!status` — 캡틴 포인트/낙찰 현황\n' +
            '`!failed_list` — 유찰 매물 현황',
          inline: false
        },
        {
          name: '🔧 관리자',
          value:
            '`!set_manager_role @역할` — 경매 관리자 역할 설정 (서버 관리자 전용)\n' +
            '`!pause` — 현재 경매 일시정지\n' +
            '`!resume` — 일시정지 해제 및 재개\n' +
            '`!rollback_last` — 직전 경매 1개만 롤백\n' +
            '`!rollback` — 경매 시작 전 상태로 전체 원복\n' +
            '`!reset` — 전체 초기화',
          inline: false
        }
      );
    msg.channel.send({ embeds: [embed] });
  }

};

// ─── 메시지 수신 ───────────────────────────────────────────────────────────────
client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.content.startsWith(PREFIX)) return;

  const [cmd, ...args] = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const handler = commands[cmd];
  if (handler) {
    try {
      await handler(msg, args);
    } catch (e) {
      console.error(e);
      msg.reply('오류가 발생했습니다.').catch(() => {});
    }
  }
});

client.once('ready', () => {
  loadData();
  console.log('✅ ' + client.user.tag + ' 온라인');
});

client.login(process.env.DISCORD_TOKEN);