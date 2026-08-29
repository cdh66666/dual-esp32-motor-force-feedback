const $ = (selector, root = document) => root.querySelector(selector);
const boards = new Map();
const focusedPort = (new URLSearchParams(location.search).get('focus') || '').toUpperCase();
let displayUnit = 'rev';
let lastModalKey = '';
let lastModalAt = 0;
let modalPort = '';

const COLORS = {
  position: '#31d5c8',
  target: '#ff6678',
  velocity: '#49a9ff',
  current: '#d68bff',
  pwm: '#4bdd92',
  bus: '#ffb64d'
};

const CHARTS = {
  multi: { title: '多圈位置', color: COLORS.position, smooth: 0.45 },
  velocity: { title: '速度', color: COLORS.velocity, smooth: 0.18 },
  current: { title: 'INA240 电机支路电流', color: COLORS.current, fixed: [-5.2, 5.2], smooth: 0.25 },
  pwm: { title: '有符号 PWM', color: COLORS.pwm, fixed: [-4095, 4095], smooth: 0.35 },
  bus: { title: '母线电压', color: COLORS.bus, fixed: [0, 30], smooth: 0.12 }
};

const PARAM_SLIDERS = new Set([
  'currentKp', 'currentKi', 'currentMaxPwm',
  'velocityKp', 'velocityKi', 'velocityMaxCurrent', 'velocityFriction',
  'positionKp', 'positionKi', 'positionKd', 'positionMaxVelocity',
  'positionMinVelocity', 'positionDeadband', 'positionLowSpeedCurrent'
]);

const MOTION_SLIDERS = {
  positionTarget: 'position',
  velocityTarget: 'velocity',
  currentTarget: 'current'
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fmt = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const positionValue = value => displayUnit === 'rev' ? value / 360 : value;
const velocityValue = value => displayUnit === 'rev' ? value / 360 : value;
const positionUnit = () => displayUnit === 'rev' ? '圈' : '°';
const velocityUnit = () => displayUnit === 'rev' ? 'rps' : '°/s';

function toast(message, bad = false) {
  const element = document.createElement('div');
  element.className = 'toast' + (bad ? ' bad' : '');
  element.textContent = message;
  $('#toast').append(element);
  setTimeout(() => element.remove(), 3200);
}

function showErrorModal(title, message, hint = '关闭后重新拖动滑块会自动准备驱动。', key = title + message) {
  const now = Date.now();
  if (key === lastModalKey && now - lastModalAt < 3000) return;
  lastModalKey = key;
  lastModalAt = now;
  $('#errorTitle').textContent = title;
  $('#errorMessage').textContent = message;
  $('#errorHint').textContent = hint;
  modalPort = (title.match(/COM\d+/i) || [''])[0].toUpperCase();
  $('#errorRecover').hidden = !modalPort;
  $('#errorModal').hidden = false;
}

$('#errorClose').addEventListener('click', () => { $('#errorModal').hidden = true; });
$('#errorRecover').addEventListener('click', async () => {
  if (!modalPort) return;
  const port = modalPort;
  $('#errorRecover').disabled = true;
  try {
    const board = boards.get(port);
    if (board) board.activeMotion = null;
    try { await send(port, 'stop'); } catch (_) {}
    await api('disconnect', { port });
    await pause(300);
    await api('connect', { port });
    await pause(700);
    await send(port, 'stop');
    await send(port, 'recover');
    await send(port, 'status');
    if (board) {
      board.powerFault = false;
      board.driverReady = true;
    }
    $('#errorModal').hidden = true;
    toast(port + ' 已停止输出并重新连接');
  } catch (error) {
    $('#errorMessage').textContent = port + ' 恢复失败：' + error.message;
    $('#errorHint').textContent = '若端口仍在但没有任何 RX 数据，请重新插拔该板 USB；电机电源可保持关闭。';
  } finally {
    $('#errorRecover').disabled = false;
  }
});

async function api(path, body) {
  const options = body ? {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  } : {};
  const response = await fetch('/api/' + path, options);
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.error || response.statusText);
  return result;
}

async function send(port, command) {
  try {
    return await api('send', { port, command });
  } catch (error) {
    toast(port + ': ' + error.message, true);
    showErrorModal(port + ' 通信失败', error.message,
      '串口写入失败。确认 USB 仍在设备管理器中，然后重新拖动控制滑块。',
      port + ':send:' + error.message);
    throw error;
  }
}

function initialBoard(port) {
  return {
    port,
    active: false,
    writeOk: false,
    hwid: '',
    seq: 0,
    polling: false,
    connecting: false,
    samples: [],
    latest: {},
    timers: {},
    configApplied: false,
    configGeneration: 0,
    configPromise: null,
    driverReady: false,
    motionGeneration: 0,
    rearmPromise: null,
    activeMotion: null,
    lastMotionSentAt: 0,
    lastFault: null,
    lastAwake: null,
    powerFault: false,
    busAddress: null,
    lastUiAt: 0,
    lastDrawAt: 0,
    lastTelemetryAt: 0,
    telemetryReconnects: 0,
    nextTelemetryReconnectAt: 0,
    dirty: true,
    range: {
      multi: { min: -180, max: 180 },
      velocity: { min: -60000, max: 60000 }
    }
  };
}

function metric(label, key) {
  return '<div class="metric"><small>' + label + '</small><b data-metric="' + key + '">—</b></div>';
}

function slider(name, label, min, max, step, value) {
  return '<label class="slider-row"><span>' + label + '</span><output data-out="' + name + '"></output>' +
    '<input data-slider="' + name + '" type="range" min="' + min + '" max="' + max +
    '" step="' + step + '" value="' + value + '"></label>';
}

function chart(key, large = false) {
  return '<section class="chart' + (large ? ' large' : '') + '" data-chart="' + key + '">' +
    '<div class="chart-head"><span>' + CHARTS[key].title + '</span><b data-chart-value="' + key + '">—</b></div>' +
    '<canvas></canvas></section>';
}

function boardHtml(board) {
  return [
    '<article class="board" data-port="', board.port, '">',
    '<div class="board-head"><div><div class="board-name"><i class="dot"></i>', board.port,
    ' <span data-connected>未连接</span></div><div class="meta" data-hwid></div></div>',
    '<div class="board-actions"><button data-act="connect">连接</button><button data-act="zero">多圈清零</button>',
    '<button data-act="clear">清空图窗</button><button data-act="export">导出原始过程 CSV</button>',
    '<button data-act="stop" class="danger">STOP（自动准备）</button></div></div>',
    '<div class="loop-banner"><strong>三级串联</strong><span>电流环 2 kHz</span><i>→</i>',
    '<span>速度环 200 Hz</span><i>→</i><span>位置环 200 Hz</span>',
    '<em>USB 原始遥测 100 Hz · 图上细线=原始，粗线=平滑显示</em></div>',
    '<div class="status">',
    metric('多圈位置', 'multi'), metric('速度', 'velocity'), metric('母线', 'bus'),
    metric('实测电流', 'current'), metric('电流目标', 'currentTarget'),
    metric('PWM', 'pwm'), metric('nFAULT', 'fault'), metric('采样', 'rate'),
    '</div>',
    '<div class="content loop-stack">',
    '<div class="loop-block position-block">', chart('multi', true),
    '<section class="loop-controls"><h3>③ 位置环 · 200 Hz</h3>',
    slider('positionTarget', '目标多圈位置', -36000, 36000, 1, 0),
    '<div class="compact-sliders">',
    slider('positionKp', '兼容 Kp（全速模式不使用）', 0, 20, 0.05, 1),
    slider('positionKi', '兼容 Ki（全速模式不使用）', 0, 2, 0.005, 0),
    slider('positionKd', '兼容 Kd（全速模式不使用）', 0, 5, 0.01, 0),
    slider('positionMaxVelocity', '最大速度 °/s（可到 60000）', 100, 60000, 100, 6000),
    slider('positionMinVelocity', '脱困最小速度 °/s', 0, 60000, 100, 0),
    slider('positionDeadband', '到位死区 °', 0.1, 10, 0.1, 3),
    slider('positionLowSpeedCurrent', '低速前进电流下限 A', 2, 7, 0.05, 2),
    '</div><div class="row"><button data-act="holdZero" class="primary">闭环保持 0°</button>',
    '<button data-act="positionTest">自动 360° 往返测试</button></div>',
    '<p class="hint">滑动目标即发送；目标范围 ±100 圈。远离目标使用设定最大速度，按制动距离自动减速；到目标附近释放，减少磁槽抖动。</p></section></div>',
    '<div class="loop-grid">',
    '<div class="loop-block">', chart('velocity'),
    '<section class="loop-controls"><h3>② 速度环 · 200 Hz</h3>',
    slider('velocityTarget', '目标速度（最高 60000 °/s）', -60000, 60000, 100, 0),
    slider('velocityDuration', '单次持续时间', 0.1, 30, 0.1, 3),
    '<div class="compact-sliders">',
    slider('velocityKp', 'Kp（A / (°/s)）', 0, 0.005, 0.00005, 0.0005),
    slider('velocityKi', 'Ki', 0, 0.005, 0.00005, 0.001),
    slider('velocityMaxCurrent', '最大电流 A', 0.1, 7, 0.05, 4.8),
    slider('velocityFriction', '静止脱困电流 A', 0, 5, 0.01, 2.2),
    '</div><p class="hint">速度环输出电流目标；同向改速连续更新，不先回零。大误差按 30 A/s 快速建立扭矩，接近目标自动软化，避免高速响应换来目标附近抖动。</p></section></div>',
    '<div class="loop-block">', chart('current'),
    '<section class="loop-controls"><h3>① 电流环 · 2 kHz</h3>',
    slider('currentTarget', '目标电流（诊断）', -7000, 7000, 10, 0),
    slider('currentDuration', '单次持续时间', 0.1, 10, 0.1, 1),
    '<div class="compact-sliders">',
    slider('currentKp', 'Kp（PWM/A）', 0, 1500, 1, 400),
    slider('currentKi', 'Ki（PWM/(A·s)）', 0, 5000, 10, 1800),
    slider('currentMaxPwm', '电流环最大 PWM', 1, 4095, 1, 4095),
    '</div><p class="hint">这是电机支路/绕组电流，不等于电源平均输入电流。INA240A1 ×20、10 mΩ；VREF/50 mΩ 使实测电流在约 5 A 封顶，6–7 A 只用于短时验证硬件限流。</p></section></div>',
    '</div>',
    '<div class="secondary-charts">', chart('pwm'), chart('bus'), '</div>',
    '<section class="utility"><div class="row"><strong>开环点动</strong>',
    slider('openPwm', 'PWM', 0, 4095, 1, 205),
    '<button data-act="ccw">反转 250 ms</button><button data-act="cw">正转 250 ms</button>',
    '<button data-act="applyAll">重新应用三环参数</button><button data-act="wake">驱动准备</button></div>',
    '<div class="row bus-row"><button data-act="businfo">总线状态</button>',
    '<button data-act="busPing">Ping 对端</button><button data-act="syncPosition">200 Hz 位置同步</button>',
    '<button data-act="syncStop">停止同步</button><span class="health" data-health>等待遥测</span></div></section>',
    '</div></article>'
  ].join('');
}

function ensureBoard(info) {
  let board = boards.get(info.port);
  if (!board) {
    board = initialBoard(info.port);
    boards.set(info.port, board);
    $('#boards').insertAdjacentHTML('beforeend', boardHtml(board));
    bindBoard(board);
  }
  const wasActive = board.active;
  board.active = Boolean(info.active);
  board.writeOk = Boolean(info.write_ok);
  board.hwid = info.hwid || info.description || '';
  if (!wasActive && board.active) {
    board.configApplied = false;
    board.driverReady = false;
    board.motionGeneration += 1;
    board.seq = 0;
  }
  if (wasActive && !board.active) {
    Object.values(board.timers).forEach(clearTimeout);
    board.driverReady = false;
    board.motionGeneration += 1;
    if (board.activeMotion) showErrorModal(board.port + ' 已断开', '控制期间 USB 串口会话消失。',
      '电机命令会在固件看门狗到期后停止；检查 USB 后重新连接。', board.port + ':disconnect');
    board.activeMotion = null;
  }
  $('.dot', board.root).classList.toggle('on', board.active && board.writeOk);
  $('[data-connected]', board.root).textContent = !board.active ? '未连接' :
    board.writeOk ? '已连接' : '已枚举 · CDC 写端点异常';
  $('[data-hwid]', board.root).textContent = board.hwid + (info.last_error ? ' · ' + info.last_error : '');
  return board;
}

function setSlider(board, name, value) {
  const input = $('[data-slider="' + name + '"]', board.root);
  if (!input) return;
  input.value = value;
  updateSliderOutput(board, input);
}

function bindBoard(board) {
  board.root = document.querySelector('[data-port="' + board.port + '"]');
  board.canvases = {};
  board.root.querySelectorAll('[data-chart]').forEach(section => {
    board.canvases[section.dataset.chart] = $('canvas', section);
  });
  board.root.querySelectorAll('[data-slider]').forEach(input => {
    input.addEventListener('input', () => {
      const name = input.dataset.slider;
      updateSliderOutput(board, input);
      if (MOTION_SLIDERS[name]) scheduleMotion(board, MOTION_SLIDERS[name], Number(input.value));
      if (PARAM_SLIDERS.has(name)) {
        board.configApplied = false;
        board.configGeneration += 1;
        scheduleConfig(board);
      }
    });
    updateSliderOutput(board, input);
  });
  board.root.addEventListener('click', event => {
    const button = event.target.closest('[data-act]');
    if (button) handleAction(board, button.dataset.act);
  });
}

function updateSliderOutput(board, input) {
  const output = $('[data-out="' + input.dataset.slider + '"]', board.root);
  if (output) output.textContent = sliderText(input.dataset.slider, Number(input.value));
}

function sliderText(name, value) {
  if (name === 'positionTarget') return fmt(positionValue(value), displayUnit === 'rev' ? 3 : 1) + ' ' + positionUnit();
  if (name === 'velocityTarget') return fmt(velocityValue(value), displayUnit === 'rev' ? 2 : 0) + ' ' + velocityUnit();
  if (name === 'currentTarget') return Math.round(value) + ' mA';
  if (name === 'velocityDuration' || name === 'currentDuration') return fmt(value, 1) + ' s';
  if (name === 'openPwm' || name === 'currentMaxPwm') return Math.round(value) + ' / 4095 · ' + fmt(value / 40.95, 1) + '%';
  if (name === 'velocityMaxCurrent' || name === 'velocityFriction') return fmt(value, 2) + ' A';
  if (name === 'positionLowSpeedCurrent') return fmt(value, 2) + ' A';
  if (name === 'positionMaxVelocity' || name === 'positionMinVelocity') return Math.round(value) + ' °/s';
  if (name === 'positionDeadband') return fmt(value, 1) + '°';
  if (name === 'velocityKp' || name === 'velocityKi') return value.toFixed(5);
  return Number.isInteger(value) ? String(value) : String(value);
}

function valueOf(board, name) {
  return Number($('[data-slider="' + name + '"]', board.root).value);
}

function scheduleConfig(board) {
  clearTimeout(board.timers.config);
  board.timers.config = setTimeout(() => {
    if (board.active) applyCascade(board, false).catch(() => {});
  }, 180);
}

function scheduleMotion(board, mode, value) {
  ['position', 'velocity', 'current'].forEach(name => {
    clearTimeout(board.timers[name]);
    delete board.timers[name];
  });
  board.motionGeneration += 1;
  const generation = board.motionGeneration;
  board.timers[mode] = setTimeout(() => {
    if (board.active) runMotion(board, mode, value, generation)
      .catch(error => toast(error.message, true));
  }, mode === 'position' ? 60 : 45);
}

async function applyCascade(board, notify = true) {
  if (!board.active) return;
  if (board.configPromise) await board.configPromise;
  if (board.configApplied) {
    if (notify) toast(board.port + ': 三环参数已应用');
    return;
  }
  const generation = board.configGeneration;
  const commands = [
    'cascade current ' + valueOf(board, 'currentKp') + ' ' +
      valueOf(board, 'currentKi') + ' ' + valueOf(board, 'currentMaxPwm'),
    'cascade velocity ' + valueOf(board, 'velocityKp') + ' ' +
      valueOf(board, 'velocityKi') + ' ' + valueOf(board, 'velocityMaxCurrent') + ' ' +
      valueOf(board, 'velocityFriction') + ' 30 30',
    'cascade position ' + valueOf(board, 'positionKp') + ' ' +
      valueOf(board, 'positionKi') + ' ' + valueOf(board, 'positionKd') + ' ' +
      valueOf(board, 'positionMaxVelocity') + ' ' + valueOf(board, 'positionDeadband') + ' ' +
      valueOf(board, 'positionMinVelocity') + ' 100000 1',
    'cascade low_speed_current ' + valueOf(board, 'positionLowSpeedCurrent'),
  ];
  const transaction = (async () => {
    for (const command of commands) await send(board.port, command);
  })();
  board.configPromise = transaction;
  try {
    await transaction;
    board.configApplied = generation === board.configGeneration;
  } finally {
    if (board.configPromise === transaction) board.configPromise = null;
  }
  if (!board.configApplied && board.active) return applyCascade(board, notify);
  if (notify) toast(board.port + ': 三环参数已应用');
}

async function ensureReady(board) {
  if (board.rearmPromise) await board.rearmPromise;
  if (!board.configApplied) await applyCascade(board, false);
  // driverReady is refreshed by every telemetry frame. Do not let a stale
  // pre-WAKE frame trigger a second reset while motion is starting.
  if (!board.driverReady) {
    await send(board.port, 'wake');
    await pause(50);
    board.driverReady = true;
  }
}

function clearMotionTimers(board) {
  Object.values(board.timers).forEach(clearTimeout);
  board.timers = {};
}

async function stopAndPrepare(board) {
  clearMotionTimers(board);
  board.motionGeneration += 1;
  board.driverReady = false;
  board.activeMotion = null;
  const generation = board.motionGeneration;
  const previous = board.rearmPromise;
  const rearm = (async () => {
    if (previous) await previous.catch(() => {});
    await send(board.port, 'stop');
    await send(board.port, 'wake');
    await pause(50);
    if (board.active && generation === board.motionGeneration) board.driverReady = true;
  })();
  board.rearmPromise = rearm;
  try {
    await rearm;
  } finally {
    if (board.rearmPromise === rearm) board.rearmPromise = null;
  }
}

async function runMotion(board, mode, value, generation = board.motionGeneration) {
  if (!board.active) return;
  if (generation !== board.motionGeneration) return;
  if (board.powerFault) {
    throw new Error(board.port + ': 功率通路故障已锁定，请先检查电机输出线/驱动通路，再点弹窗中的恢复按钮');
  }
  if (!Number.isFinite(board.latest.bus) || board.latest.bus < 6) {
    throw new Error(board.port + ': 电机母线仅 ' + fmt(board.latest.bus, 2) + ' V，欠压，未执行动作');
  }
  if (!board.latest.fault) {
    throw new Error(board.port + ': nFAULT=0，未执行动作');
  }
  await ensureReady(board);
  if (generation !== board.motionGeneration) return;
  const timeoutMs = mode === 'velocity'
    ? Math.round(clamp(valueOf(board, 'velocityDuration'), 0.1, 30) * 1000)
    : mode === 'current'
      ? Math.round(clamp(valueOf(board, 'currentDuration'), 0.1, 10) * 1000)
      : 30000;
  if (mode === 'position') await send(board.port, 'pos ' + value + ' 4095 ' + timeoutMs);
  if (mode === 'velocity') await send(board.port, 'velocity ' + value + ' 4095 ' + timeoutMs);
  if (mode === 'current') await send(board.port, 'current ' + value + ' 4095 ' + timeoutMs);
  board.activeMotion = { mode, value, timeoutMs };
  board.lastMotionSentAt = Date.now();
}

async function renewMotion(board) {
  if (!board.active || !board.activeMotion) return;
  const { mode, value, timeoutMs = 30000 } = board.activeMotion;
  if (mode !== 'position') {
    if (Date.now() - board.lastMotionSentAt >= timeoutMs) board.activeMotion = null;
    return;
  }
  if (Date.now() - board.lastMotionSentAt < 10000) return;
  if (!board.latest.fault || !board.latest.awake) {
    const reason = !board.latest.fault ? 'nFAULT=0' : '驱动已休眠';
    board.activeMotion = null;
    showErrorModal(board.port + ' 控制已停止', reason,
      '这是硬故障或驱动状态变化，不会自动重启。排除原因后重新拖动滑块。', board.port + ':' + reason);
    return;
  }
  const command = mode === 'position' ? 'pos ' + value + ' 4095 30000' :
    mode === 'velocity' ? 'velocity ' + value + ' 4095 30000' :
      'current ' + value + ' 4095 30000';
  try {
    await send(board.port, command);
    board.lastMotionSentAt = Date.now();
  } catch (error) {
    board.activeMotion = null;
    showErrorModal(board.port + ' 控制续租失败', error.message,
      '命令未续租，固件将在 30 秒安全超时。恢复串口后重新拖动滑块。', board.port + ':renew');
  }
}

async function resetBoard(board) {
  clearMotionTimers(board);
  board.motionGeneration += 1;
  board.activeMotion = null;
  board.driverReady = false;
  await send(board.port, 'stop');
  await send(board.port, 'recover');
  await send(board.port, 'status');
  board.powerFault = false;
  board.driverReady = true;
}

async function runPositionTest(board) {
  clearTimeout(board.timers.positionTest);
  await stopAndPrepare(board);
  await send(board.port, 'encreset');
  await pause(80);
  await runMotion(board, 'position', 360);
  board.timers.positionTest = setTimeout(() => {
    runMotion(board, 'position', 0).catch(() => {});
  }, 2600);
  toast(board.port + ': 360° 到位后自动回零');
}

function exportCsv(board) {
  if (!board.samples.length) {
    toast(board.port + ': 暂无过程数据', true);
    return;
  }
  const keys = [
    't_ms', 'single_deg', 'multi_deg', 'position_target_deg', 'position_error_deg',
    'velocity_deg_s', 'velocity_target_deg_s', 'current_measured_A', 'current_target_A',
    'bus_V', 'pwm_signed', 'pwm_abs', 'nFAULT', 'awake', 'control', 'settled'
  ];
  const rows = board.samples.map(sample => [
    sample.t, sample.single, sample.multi, sample.multiTarget,
    sample.multiTarget - sample.multi, sample.velocity, sample.velocityTarget,
    sample.current, sample.currentTarget, sample.bus, sample.pwm,
    sample.pwmMagnitude, sample.fault, sample.awake, sample.control, sample.settled
  ]);
  const csv = [keys.join(','), ...rows.map(row => row.join(','))].join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = board.port + '-cascade-process-' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function handleAction(board, action) {
  try {
    if (action === 'connect') await api('connect', { port: board.port });
    if (action === 'stop') await stopAndPrepare(board);
    if (action === 'zero') await send(board.port, 'encreset');
    if (action === 'clear') {
      board.samples.length = 0;
      board.range.multi = { min: -180, max: 180 };
      board.range.velocity = { min: -60000, max: 60000 };
      board.dirty = true;
    }
    if (action === 'export') exportCsv(board);
    if (action === 'applyAll') await applyCascade(board);
    if (action === 'wake') await ensureReady(board);
    if (action === 'holdZero') await runMotion(board, 'position', 0);
    if (action === 'positionTest') await runPositionTest(board);
    if (action === 'cw' || action === 'ccw') {
      await ensureReady(board);
      await send(board.port, action + ' ' + valueOf(board, 'openPwm') + ' 250');
    }
    if (action === 'businfo') await send(board.port, 'businfo');
    if (action === 'busPing') {
      const peer = [...boards.values()].find(item => item.port !== board.port && item.busAddress);
      if (!peer) throw new Error('尚未读到对端总线地址');
      await send(board.port, 'bus ' + peer.busAddress + ' ping');
    }
    if (action === 'syncPosition') {
      const peer = [...boards.values()].find(item => item.port !== board.port && item.busAddress);
      if (!peer) throw new Error('尚未读到对端总线地址');
      await send(board.port, 'sync position ' + peer.busAddress + ' 0 4095 30000');
    }
    if (action === 'syncStop') await send(board.port, 'sync stop');
  } catch (error) {
    toast(board.port + ': ' + error.message, true);
    showErrorModal(board.port + ' 操作失败', error.message, undefined,
      board.port + ':action:' + error.message);
  }
}

function numeric(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function parseLine(board, text) {
  board.lastTelemetryAt = Date.now();
  board.telemetryReconnects = 0;
  if (text.startsWith('S,')) {
    const part = text.split(',');
    if (part.length < 14) return;
    const pwmMagnitude = numeric(part[6]);
    const phase = numeric(part[14]);
    const legacySigned = part.length > 15 ? numeric(part[15]) : (phase ? pwmMagnitude : -pwmMagnitude);
    const control = numeric(part[12]);
    const cascadePwm = part.length > 23 ? numeric(part[23], legacySigned) : legacySigned;
    const measuredCurrent = part.length > 22 ? numeric(part[22]) / 1000 : numeric(part[5]) / 1000;
    const sample = {
      t: numeric(part[1]),
      single: numeric(part[2]),
      multi: numeric(part[3]),
      bus: numeric(part[4]),
      current: measuredCurrent,
      pwm: cascadePwm,
      pwmMagnitude,
      fault: numeric(part[7]),
      awake: numeric(part[8]),
      step: numeric(part[9]),
      raw: numeric(part[10]),
      velocity: numeric(part[11]),
      control,
      multiTarget: control === 3 ? numeric(part[13]) : numeric(part[3]),
      phase,
      settled: part.length > 19 ? numeric(part[19]) : 0,
      velocityTarget: part.length > 20 ? numeric(part[20]) : 0,
      currentTarget: part.length > 21 ? numeric(part[21]) / 1000 : 0
    };
    board.driverReady = sample.awake === 1;
    if (board.lastFault === 1 && sample.fault === 0) {
      board.activeMotion = null;
      showErrorModal(board.port + ' 驱动故障', 'nFAULT 从 1 变为 0，PWM 已停止。',
        '检查驱动过流、欠压、过温及电机输出线；排除后重新拖动滑块。', board.port + ':nfault');
    }
    if (board.lastAwake === 1 && sample.awake === 0 && board.activeMotion) {
      board.activeMotion = null;
      showErrorModal(board.port + ' 驱动休眠', '运行中 awake 从 1 变为 0。',
        '重新拖动滑块会自动 WAKE；若重复出现请检查复位和休眠线路。', board.port + ':sleep');
    }
    board.lastFault = sample.fault;
    board.lastAwake = sample.awake;
    if (board.samples.length && sample.t < board.samples[board.samples.length - 1].t) {
      board.samples.length = 0;
      board.activeMotion = null;
      board.motionGeneration += 1;
      board.driverReady = false;
      showErrorModal(board.port + ' 控制器已重启',
        '检测到板端时间戳回退，已清除重启前的全部控制续租。',
        '旧位置、速度和电流目标不会自动恢复；确认状态后再手动操作。',
        board.port + ':controller-reboot');
    }
    board.latest = sample;
    if (board.activeMotion?.mode === 'position' && sample.settled === 1) {
      board.activeMotion = null;
    }
    board.samples.push(sample);
    if (board.samples.length > 1200) board.samples.splice(0, board.samples.length - 1200);
    updateRanges(board, sample);
    board.dirty = true;
    return;
  }
  const address = text.match(/BUS addr=(\d+)/);
  if (address) board.busAddress = Number(address[1]);
  if (/CASCADE (?:no_current_response|no_power_response)|ERR power_path_fault_latched/.test(text)) {
    board.powerFault = true;
    board.activeMotion = null;
  }
  if (text.startsWith('OK recovered power_path_fault=0')) board.powerFault = false;
  if (/^(DIAG|ERR|MODEL|CASCADE_CFG|BUS_|SYNC_|SYNC )/.test(text)) {
    const health = $('[data-health]', board.root);
    health.textContent = text;
    health.className = 'health ' + (text.startsWith('ERR') ? 'bad' : 'good');
    if (/^(ERR)|CASCADE (timeout|fault|bus_low|no_current_response|no_power_response)|MODEL timeout/.test(text)) {
      board.activeMotion = null;
      showErrorModal(board.port + ' 控制器报告异常', text,
        text.includes('timeout') ? '控制命令已超时。网页在线时会自动续租；重新拖动滑块可立即恢复。' :
          '先排除提示的电源、nFAULT 或参数问题，再重新拖动滑块。', board.port + ':' + text);
    }
    if (text.startsWith('SYNC mode=force')) {
      const state = $('#forceState');
      state.textContent = board.port + ' · ' + text;
      state.className = text.includes('armed=1') && !text.includes('timeout=1') ? 'good' : 'bad';
    }
  }
}

function expandRange(range, values, minimumSpan, quantum) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return;
  const low = Math.min(...finite);
  const high = Math.max(...finite);
  if (low >= range.min * 0.95 && high <= range.max * 0.95) return;
  const center = (low + high) / 2;
  const span = Math.max(minimumSpan, (high - low) * 1.35);
  range.min = Math.floor((center - span / 2) / quantum) * quantum;
  range.max = Math.ceil((center + span / 2) / quantum) * quantum;
}

function updateRanges(board, sample) {
  expandRange(board.range.multi, [sample.multi, sample.multiTarget], 360, 90);
  expandRange(board.range.velocity, [sample.velocity, sample.velocityTarget], 36000, 1000);
}

async function pollLogs(board) {
  if (!board.active || board.polling) return;
  board.polling = true;
  try {
    const result = await api('logs?port=' + encodeURIComponent(board.port) + '&since=' + board.seq);
    result.logs.forEach(entry => {
      board.seq = Math.max(board.seq, entry.seq);
      if (entry.direction === 'rx') parseLine(board, entry.text);
      if (entry.direction === 'error') {
        board.activeMotion = null;
        showErrorModal(board.port + ' 串口读取失败', entry.text,
          '已停止续发控制命令。点击“停止输出并重新连接”恢复串口。',
          board.port + ':serial:' + entry.text);
      }
      if (entry.direction === 'system' && entry.text === 'reader stopped') {
        board.activeMotion = null;
      }
    });
  } catch (_) {
    board.active = false;
  } finally {
    board.polling = false;
  }
}

async function refreshPorts() {
  try {
    const result = await api('ports');
    const ports = result.ports.filter(port => port.esp32).sort((a, b) => {
      const af = a.port.toUpperCase() === focusedPort ? 0 : 1;
      const bf = b.port.toUpperCase() === focusedPort ? 0 : 1;
      return af - bf || a.port.localeCompare(b.port, undefined, { numeric: true });
    });
    ports.forEach(info => {
      const board = ensureBoard(info);
      if (!info.active && !board.connecting) {
        board.connecting = true;
        api('connect', { port: info.port }).catch(() => {}).finally(() => { board.connecting = false; });
      }
      const telemetryStale = info.active && info.connected_age_ms > 3000 && !info.telemetry_ok;
      if (telemetryStale && !board.connecting && Date.now() >= board.nextTelemetryReconnectAt) {
        board.activeMotion = null;
        if (board.telemetryReconnects < 2) {
          board.telemetryReconnects += 1;
          board.nextTelemetryReconnectAt = Date.now() + 3500;
          board.connecting = true;
          api('disconnect', { port: info.port })
            .then(() => pause(250))
            .then(() => api('connect', { port: info.port }))
            .catch(() => {})
            .finally(() => { board.connecting = false; });
        } else {
          board.nextTelemetryReconnectAt = Date.now() + 10000;
          showErrorModal(info.port + ' 无遥测数据',
            'USB 端口存在且命令可写，但连续 3 秒没有收到任何板端数据。',
            '控制续发已停止。点击恢复重连；若仍失败，请重新插拔该板 USB。',
            info.port + ':telemetry-stale');
        }
      }
    });
    $('#portSummary').textContent = ports.length ?
      ports.map(port => port.port + (port.active ? ' 已连接' : ' 正在连接')).join(' · ') :
      '未发现 ESP32 USB 串口';
  } catch (error) {
    $('#portSummary').textContent = '端口检测失败：' + error.message;
  }
}

function telemetryRate(board) {
  const samples = board.samples.slice(-101);
  if (samples.length < 3) return NaN;
  const duration = samples[samples.length - 1].t - samples[0].t;
  return duration > 0 ? (samples.length - 1) * 1000 / duration : NaN;
}

function updateUi(board) {
  const sample = board.latest;
  if (!Number.isFinite(sample.t)) return;
  const set = (key, value) => {
    const element = $('[data-metric="' + key + '"]', board.root);
    if (element) element.textContent = value;
  };
  set('multi', fmt(positionValue(sample.multi), displayUnit === 'rev' ? 3 : 2) + ' ' + positionUnit());
  set('velocity', fmt(velocityValue(sample.velocity), displayUnit === 'rev' ? 2 : 0) + ' ' + velocityUnit());
  set('bus', fmt(sample.bus, 2) + ' V');
  set('current', fmt(sample.current, 3) + ' A');
  set('currentTarget', fmt(sample.currentTarget, 3) + ' A');
  set('pwm', fmt(sample.pwm, 0) + ' / 4095');
  set('fault', sample.fault ? '1 · 正常' : '0 · 故障');
  set('rate', fmt(telemetryRate(board), 1) + ' Hz');
  Object.keys(board.canvases).forEach(key => {
    const element = $('[data-chart-value="' + key + '"]', board.root);
    if (!element) return;
    if (key === 'multi') element.textContent = '实测 ' + fmt(positionValue(sample.multi), displayUnit === 'rev' ? 3 : 2) +
      ' / 目标 ' + fmt(positionValue(sample.multiTarget), displayUnit === 'rev' ? 3 : 2) + ' ' + positionUnit();
    if (key === 'velocity') element.textContent = '实测 ' + fmt(velocityValue(sample.velocity), displayUnit === 'rev' ? 2 : 0) +
      ' / 目标 ' + fmt(velocityValue(sample.velocityTarget), displayUnit === 'rev' ? 2 : 0) + ' ' + velocityUnit();
    if (key === 'current') element.textContent = '实测 ' + fmt(sample.current, 3) +
      ' / 目标 ' + fmt(sample.currentTarget, 3) + ' A';
    if (key === 'pwm') element.textContent = fmt(sample.pwm, 0) + ' / 4095';
    if (key === 'bus') element.textContent = fmt(sample.bus, 2) + ' V';
  });
}

function chartValue(sample, key) {
  if (key === 'multi') return positionValue(sample.multi);
  if (key === 'velocity') return velocityValue(sample.velocity);
  return sample[key];
}

function targetValue(sample, key) {
  if (key === 'multi') return positionValue(sample.multiTarget);
  if (key === 'velocity') return velocityValue(sample.velocityTarget);
  if (key === 'current') return sample.currentTarget;
  return NaN;
}

function axisRange(board, key) {
  if (CHARTS[key].fixed) return [...CHARTS[key].fixed];
  const range = board.range[key];
  let min = range.min;
  let max = range.max;
  if (displayUnit === 'rev' && (key === 'multi' || key === 'velocity')) {
    min /= 360;
    max /= 360;
  }
  return [min, max];
}

function nice(value) {
  const absolute = Math.abs(value);
  if (absolute >= 1000) return value.toFixed(0);
  if (absolute >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function drawChart(board, key, canvas) {
  const bounds = canvas.getBoundingClientRect();
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const width = Math.round(bounds.width * dpr);
  const height = Math.round(bounds.height * dpr);
  if (width < 40 || height < 40) return;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, width, height);
  const pad = { left: 62 * dpr, right: 14 * dpr, top: 14 * dpr, bottom: 27 * dpr };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const [min, max] = axisRange(board, key);
  const scaleY = value => pad.top + (max - clamp(value, min, max)) / (max - min) * plotHeight;

  context.strokeStyle = '#263b50';
  context.fillStyle = '#8fa8ba';
  context.font = (11 * dpr) + 'px system-ui';
  context.lineWidth = dpr;
  context.textAlign = 'right';
  for (let index = 0; index <= 4; index += 1) {
    const y = pad.top + plotHeight * index / 4;
    context.beginPath();
    context.moveTo(pad.left, y);
    context.lineTo(width - pad.right, y);
    context.stroke();
    context.fillText(nice(max - (max - min) * index / 4), pad.left - 7 * dpr, y + 4 * dpr);
  }
  context.textAlign = 'center';
  for (let index = 0; index <= 5; index += 1) {
    const x = pad.left + plotWidth * index / 5;
    context.beginPath();
    context.moveTo(x, pad.top);
    context.lineTo(x, pad.top + plotHeight);
    context.stroke();
    context.fillText((-10 + index * 2) + 's', x, height - 6 * dpr);
  }

  const samples = board.samples.slice(-1000);
  if (samples.length < 2) return;
  const offset = 1000 - samples.length;
  const scaleX = index => pad.left + (offset + index) / 999 * plotWidth;

  const stroke = (getter, color, lineWidth, alpha, smoothAlpha = 1) => {
    context.strokeStyle = color;
    context.lineWidth = lineWidth * dpr;
    context.globalAlpha = alpha;
    context.beginPath();
    let filtered = NaN;
    let began = false;
    samples.forEach((sample, index) => {
      const raw = getter(sample);
      if (!Number.isFinite(raw)) return;
      filtered = Number.isFinite(filtered) ? filtered + (raw - filtered) * smoothAlpha : raw;
      const x = scaleX(index);
      const y = scaleY(filtered);
      if (!began) {
        context.moveTo(x, y);
        began = true;
      } else {
        context.lineTo(x, y);
      }
    });
    if (began) context.stroke();
    context.globalAlpha = 1;
  };

  stroke(sample => chartValue(sample, key), CHARTS[key].color, 1, 0.24, 1);
  stroke(sample => chartValue(sample, key), CHARTS[key].color, 2.1, 1, CHARTS[key].smooth);
  if (key === 'multi' || key === 'velocity' || key === 'current') {
    context.setLineDash([6 * dpr, 5 * dpr]);
    stroke(sample => targetValue(sample, key), COLORS.target, 1.4, 0.95, 1);
    context.setLineDash([]);
  }
}

function animationFrame(now) {
  boards.forEach(board => {
    if (now - board.lastUiAt >= 100) {
      updateUi(board);
      board.lastUiAt = now;
    }
    if (board.dirty && now - board.lastDrawAt >= 33) {
      Object.entries(board.canvases).forEach(([key, canvas]) => drawChart(board, key, canvas));
      board.lastDrawAt = now;
      board.dirty = false;
    }
  });
  requestAnimationFrame(animationFrame);
}

$('#unit').addEventListener('change', event => {
  displayUnit = event.target.value;
  boards.forEach(board => {
    board.root.querySelectorAll('[data-slider]').forEach(input => updateSliderOutput(board, input));
    board.dirty = true;
  });
  const value = Number($('#fleetTarget').value);
  $('#fleetTargetOut').textContent = fmt(positionValue(value), displayUnit === 'rev' ? 3 : 0) + ' ' + positionUnit();
});

$('#fleetTarget').addEventListener('input', event => {
  const value = Number(event.target.value);
  $('#fleetTargetOut').textContent = fmt(positionValue(value), displayUnit === 'rev' ? 3 : 0) + ' ' + positionUnit();
});

$('#connectAll').addEventListener('click', () => {
  Promise.all([...boards.values()].map(board => api('connect', { port: board.port }))).catch(() => {});
});

$('#stopAll').addEventListener('click', () => {
  Promise.all([...boards.values()].filter(board => board.active).map(stopAndPrepare)).catch(() => {});
});

$('#resetAll').addEventListener('click', () => {
  const active = [...boards.values()].filter(board => board.active);
  Promise.all(active.map(resetBoard))
    .then(() => toast('全部在线板已 STOP 并复位；旧目标未恢复'))
    .catch(error => showErrorModal('复位失败', error.message,
      '检查母线、nFAULT 和 USB 通信后重试。', 'reset-all'));
});

$('#fleetSend').addEventListener('click', () => {
  const target = Number($('#fleetTarget').value);
  Promise.all([...boards.values()].filter(board => board.active).map(board => runMotion(board, 'position', target)))
    .catch(error => toast(error.message, true));
});

function updateForceOutputs() {
  $('#forceKOut').textContent = Number($('#forceK').value).toFixed(1) + ' mA/°';
  $('#forceDOut').textContent = Number($('#forceD').value).toFixed(2) + ' mA/(°/s)';
  $('#forceLimitOut').textContent = Math.round(Number($('#forceLimit').value)) + ' mA';
}

async function forcePair() {
  let pair = [...boards.values()].filter(board => board.active);
  if (pair.length !== 2) throw new Error('需要恰好两块在线板');
  await Promise.all(pair.map(board => send(board.port, 'businfo')));
  await pause(250);
  pair = pair.filter(board => Number.isInteger(board.busAddress));
  if (pair.length !== 2 || pair[0].busAddress === pair[1].busAddress) {
    throw new Error('两块板必须具有不同 DATA 地址');
  }
  return pair;
}

async function startForceFeedback() {
  const state = $('#forceState');
  state.textContent = '正在建立 1 Mbaud 双向链路…';
  state.className = '';
  const pair = await forcePair();
  await Promise.all(pair.map(async board => {
    await send(board.port, 'stop');
    await ensureReady(board);
  }));
  const stiffness = Number($('#forceK').value);
  const damping = Number($('#forceD').value);
  const limit = Number($('#forceLimit').value);
  // Configure the higher address first. It only responds; configuring the
  // lower-address request owner last avoids a false startup timeout.
  const ordered = [...pair].sort((a, b) => b.busAddress - a.busAddress);
  for (const board of ordered) {
    const peer = pair.find(item => item !== board);
    await send(board.port, 'sync force ' + peer.busAddress + ' ' + stiffness + ' ' +
      damping + ' 0 ' + limit + ' 4095 30000 0');
    await pause(80);
  }
  await pause(250);
  await Promise.all(pair.map(board => send(board.port, 'sync status')));
  state.textContent = '双向力反馈运行中 · 任一链路超时会双板 PWM=0';
  state.className = 'good';
}

async function stopForceFeedback() {
  const pair = [...boards.values()].filter(board => board.active);
  await Promise.all(pair.map(board => send(board.port, 'sync stop')));
  $('#forceState').textContent = '力反馈已停止 · PWM=0';
  $('#forceState').className = '';
}

['forceK', 'forceD', 'forceLimit'].forEach(id => $('#' + id).addEventListener('input', updateForceOutputs));
$('#forceStart').addEventListener('click', () => startForceFeedback().catch(error => {
  $('#forceState').textContent = error.message;
  $('#forceState').className = 'bad';
  toast('力反馈启动失败：' + error.message, true);
}));
$('#forceStop').addEventListener('click', () => stopForceFeedback().catch(error => toast(error.message, true)));
updateForceOutputs();

await refreshPorts();
setInterval(refreshPorts, 1000);
setInterval(() => boards.forEach(pollLogs), 40);
setInterval(() => boards.forEach(board => renewMotion(board)), 1000);
requestAnimationFrame(animationFrame);
