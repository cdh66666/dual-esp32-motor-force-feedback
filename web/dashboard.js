const $ = (selector, root = document) => root.querySelector(selector);
const boards = new Map();
const focusedPort = (new URLSearchParams(location.search).get('focus') || '').toUpperCase();
let displayUnit = 'rev';
let lastModalKey = '';
let lastModalAt = 0;
let modalPort = '';
const issueShownAt = new Map();
let forceOperation = Promise.resolve();
const forceSession = { active: false, boards: [], token: 0 };
const autoTune = { active: false, cancelled: false, reports: [] };

function forceState(text, className = '') {
  const state = $('#forceState');
  if (!state) return;
  state.textContent = text;
  state.className = className;
}

function forceLocked(task) {
  const run = forceOperation.then(task, task);
  forceOperation = run.catch(() => {});
  return run;
}

function reportLinkIssue(port, message) {
  const board = boards.get(port);
  if (!board) return;
  clearMotionTimers(board);
  board.motionGeneration += 1;
  board.activeMotion = null;
  board.driverReady = false;
  board.linkFault = true;
  const panel = $('[data-link-issue]', board.root);
  panel.hidden = false;
  $('[data-link-message]', panel).textContent = message;
  // Persistent, visible status instead of repeated modal interruptions.
  // Faults remain in the backend capture; this never resumes an old target.
}

async function recoverConnection(board) {
  clearMotionTimers(board);
  board.motionGeneration += 1;
  board.activeMotion = null;
  const fresh = board.active && !board.linkFault && Date.now() - board.lastTelemetryAt < 1000;
  if (fresh) {
    await send(board.port, 'stop');
    if (board.powerFault) await send(board.port, 'recover');
    await send(board.port, 'status');
  } else {
    await api('recover-link', {port:board.port});
  }
  $('[data-link-issue]', board.root).hidden = true;
  board.linkFault = false;
  toast(board.port + (fresh ? ' 已清除动作；保留串口连接' : ' 链路已恢复，旧目标不会自动运行'));
}

const COLORS = {
  position: '#31d5c8',
  target: '#ff6678',
  velocity: '#49a9ff',
  current: '#d68bff',
  pwm: '#4bdd92',
  bus: '#ffb64d'
};

const CHARTS = {
  multi: { title: '输出轴多圈位置', color: COLORS.position, smooth: 0.45 },
  velocity: { title: '输出轴速度', color: COLORS.velocity, smooth: 0.18 },
  current: { title: 'INA240 电机支路电流', color: COLORS.current, smooth: 0.24 },
  pwm: { title: '有符号 PWM', color: COLORS.pwm, smooth: 0.28 },
  bus: { title: '母线电压', color: COLORS.bus, smooth: 0.18 }
};

// The old axes only expanded and therefore stayed at the largest value ever
// seen.  A 1-turn move after a previous high-speed sweep was then rendered as
// a flat line around zero.  These bounds are display-independent (degrees,
// deg/s, A, PWM counts and V respectively) and are recomputed from the last
// ten seconds of samples.  Signed channels keep zero in view; position and
// bus voltage stay centred on their actual data so small motions remain
// readable.
const CHART_SCALE = {
  multi: { minSpan: 0.5, padding: 0.18, quantum: 0.1, symmetric: false },
  velocity: { minSpan: 20, padding: 0.15, quantum: 10, symmetric: true },
  current: { minSpan: 0.1, padding: 0.18, quantum: 0.01, symmetric: true },
  pwm: { minSpan: 200, padding: 0.15, quantum: 100, symmetric: true },
  bus: { minSpan: 1, padding: 0.12, quantum: 0.5, symmetric: false }
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
const fmt = (value, digits = 2) => Number.isFinite(value) ? (Math.abs(value)<.005?0:value).toFixed(2) : '—';
const positionValue = value => displayUnit === 'rev' ? value / 360 : value;
const velocityValue = value => displayUnit === 'rev' ? value / 360 : value;
const positionUnit = () => displayUnit === 'rev' ? '圈' : '°';
const velocityUnit = () => displayUnit === 'rev' ? 'rps' : '°/s';
const serialNumber = value => Number(Number(value).toPrecision(10));
function gearOf(board) {
  if (!Number.isFinite(board.gear) || board.gear < 1) throw new Error('等待板端减速比，未发送输出轴目标');
  return board.gear;
}
const ANGLE_PARAMS = new Set(['positionMaxVelocity', 'positionMinVelocity', 'positionDeadband']);
const SPEED_GAINS = new Set(['velocityKp', 'velocityKi']);
function parameterFromMotor(board, name, value) {
  return serialNumber(ANGLE_PARAMS.has(name) ? value / gearOf(board) :
    SPEED_GAINS.has(name) ? value * gearOf(board) : value);
}
function parameterToMotor(board, name) {
  const value = valueOf(board, name);
  return serialNumber(ANGLE_PARAMS.has(name) ? value * gearOf(board) :
    SPEED_GAINS.has(name) ? value / gearOf(board) : value);
}
function positionCommand(board, outputDegrees, duration = 30000, maxDuty = 4095) {
  return (board.outputPosition ? 'posout ' : 'pos ') +
    serialNumber(outputDegrees * (board.outputPosition ? 1 : gearOf(board))) + ' ' + maxDuty + ' ' + duration;
}

function toast(message, bad = false) {
  const element = document.createElement('div');
  element.className = 'toast' + (bad ? ' bad' : '');
  element.textContent = message;
  $('#toast').append(element);
  setTimeout(() => element.remove(), 3200);
}

function showErrorModal(title, message, hint = '关闭后重新拖动滑块会自动准备驱动。', key = title + message) {
  const now = Date.now();
  if (now - (issueShownAt.get(key) || 0) < 30000) return;
  issueShownAt.set(key, now);
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
    if (!board) return;
    await recoverConnection(board);
    $('#errorModal').hidden = true;
  } catch (error) {
    $('#errorMessage').textContent = port + ' 恢复失败：' + error.message;
    $('#errorHint').textContent = '若端口仍在但没有任何 RX 数据，请重新插拔该板 USB；电机电源可保持关闭。';
  } finally {
    $('#errorRecover').disabled = false;
  }
});

async function api(path, body, timeoutMs = path === 'recover-link' ? 10000 : 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const options = body ? {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  } : {};
  options.signal = controller.signal;
  try {
    const response = await fetch('/api/' + path, options);
    const result = await response.json();
    if (!response.ok || result.ok === false) {
      const error = new Error(result.error || response.statusText);
      error.kind = result.error_kind || 'transport';
      throw error;
    }
    return result;
  } catch (error) {
    if (error.name === 'AbortError') {
      const failure = new Error('本机服务请求超时；未自动重发动作，请检查连接状态');
      failure.kind = 'transport';
      throw failure;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function send(port, command, owner = null) {
  if (autoTune.active && owner !== autoTune) {
    if (/^(stop|sleep|sync stop|knob stop)$/.test(command)) autoTune.cancelled = true;
    else if (!/^(status|diag|model|motorprofile status|cascade status|knob status|sync status|businfo|encoder)$/.test(command)) {
      throw new Error('自动整定中，请先停止再切换操作');
    }
  }
  try {
    const checked = /^(stop|wake|sleep|recover|status|diag|model|motorprofile|motorset|cascade|pos|posout|knob|velocity|current|cw|ccw|stream|trace|encreset|direction|sensepolarity|setstep|led|decay|businfo|encoder|rawadc)(\s|$)/.test(command) || /^sync (status|off|stop|disarm|arm|position|force)(\s|$)/.test(command);
    const result = await api('send', { port, command, wait_ack: checked,
      session_id: boards.get(port)?.sessionId || undefined });
    if (checked && !result.acknowledged) throw new Error('板端执行回执未确认，请更新本机服务');
    return result;
  } catch (error) {
    if (error.kind === 'cancelled') throw error;
    if (error.kind === 'validation' || (error.kind === 'controller' &&
        /^ERR (usage:|knob config|knob start requires STOP|knob invalid session token|.*outside limits)/.test(error.message))) {
      toast(port+' · 本次输入未采用：'+error.message, true);
    } else if (error.kind === 'controller') {
      showErrorModal(port + ' 控制器未执行', error.message,
        '串口可能正常；请按具体原因处理，不必直接重连。', port + ':' + error.message);
    } else reportLinkIssue(port, error.message + '；动作已暂停，可点“恢复链路”，无需反复关闭弹窗。');
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
    configDirty: false,
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
    motorProfile: null,
    gear: null,
    outputPosition: false,
    knobSupported: false,
    knobOrigin: 0,
    knobRenewing: false,
    pendingMotion: null,
    motionFlushing: false,
    lastMotionFlushAt: 0,
    positionHold: false,
    appliedCommands: {},
    sessionId: null,
    // The first log batch can contain the controller's retained history. Do
    // not turn an old fault into a new blocking dialog on every page load.
    faultAlertsReady: true,
    drawTimes: [],
    busAddress: null,
    lastBusPong: null,
    lastUiAt: 0,
    lastDrawAt: 0,
    lastTelemetryAt: 0,
    telemetryReconnects: 0,
    nextTelemetryReconnectAt: 0,
    noTelemetryWarned: false,
    rxAgeMs: null,
    dirty: true,
    range: {
      multi: { min: -0.25, max: 0.25 },
      velocity: { min: -10, max: 10 },
      current: { min: -0.05, max: 0.05 },
      pwm: { min: -100, max: 100 },
      bus: { min: 18, max: 20 }
    },
    rangeUpdatedAt: 0
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

function targetWindow(name) {
  return '<label class="target-window">滑块范围（仅调整量程，不发送） <select data-window="' + name + '"></select></label>';
}

function refreshWindowLabels(board) {
  board.root.querySelectorAll('[data-window] option').forEach(option => {
    const name = option.parentElement.dataset.window;
    const half = Number(option.value);
    option.textContent = '±' + (name === 'currentTarget' ? half + ' mA' :
      fmt(positionValue(half), displayUnit === 'rev' ? 5 : 1) + ' ' +
      (name === 'positionTarget' ? positionUnit() : velocityUnit()));
  });
}

function configureTargetWindows(board) {
  const gear = gearOf(board);
  const speedLimit = (board.motorProfile === '36gp555' ? 48000 : board.motorProfile === '25ga370' ? 4200 : 60000) / gear;
  const positionLimit = board.outputPosition ? 36000 : 36000 / gear;
  const currentLimit = board.motorProfile === '775' ? 7000 : 2000;
  const options = {
    positionTarget: [1, 10, 180, 1080, positionLimit].filter(value => value <= positionLimit),
    velocityTarget: board.motorProfile === '36gp555' ? [36, 360, 1800, speedLimit] : [360 / gear, 3600 / gear, speedLimit],
    currentTarget: [100, 500, currentLimit]
  };
  board.targetLimits = {positionTarget:positionLimit, velocityTarget:speedLimit, currentTarget:currentLimit};
  Object.entries(options).forEach(([name, widths]) => {
    const select = $('[data-window="' + name + '"]', board.root);
    select.replaceChildren(...[...new Set(widths)].map(width => {
      const option = document.createElement('option'); option.value = width; return option;
    }));
    select.value = name === 'positionTarget' ? 180 : name === 'currentTarget' ? 500 : widths[1];
    setTargetWindow(board, name, Number(select.value));
  });
  refreshWindowLabels(board);
}

function setTargetWindow(board, name, half) {
  if (!Number.isFinite(half) || half <= 0) return;
  const input = $('[data-slider="' + name + '"]', board.root);
  const value = Number(input.value);
  const limit = board.targetLimits?.[name] || Math.max(Math.abs(Number(input.min)), Math.abs(Number(input.max)));
  // View changes keep the target representable and never send commands.
  const center = name === 'positionTarget' && half < limit ? value : 0;
  input.min = Math.max(-limit, Math.min(value, center - half));
  input.max = Math.min(limit, Math.max(value, center + half));
  input.step = 'any';
  input.value = value;
  updateSliderOutput(board, input);
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
    '<button data-act="clear">清空图窗</button><button data-act="export">导出输出轴过程 CSV</button>',
    '<button data-act="stop" class="danger">STOP（自动准备）</button></div></div>',
    '<div class="link-issue" data-link-issue hidden role="status"><span data-link-message></span>',
    '<button data-act="recoverLink">恢复链路</button></div>',
    '<div class="motor-profile-bar"><strong>电机档案</strong><select data-profile>',
    '<option value="775">775 · 12–24 V · 高速</option>',
    '<option value="25ga370">25GA-370 · 6 V 电机 / SS6952T VM 8–50 V</option>',
    '<option value="36gp555">36GP-555 · 24 V / 1538 rpm / 1:5.2</option></select>',
    '<button data-act="applyProfile" class="primary">应用档案</button>',
    '<span data-profile-status>等待板端档案</span></div>',
    '<div class="hint" data-compensation>角度扰动补偿：等待板端校准状态</div>',
    '<div class="loop-banner"><strong>三级串联</strong><span>电流环 2 kHz</span><i>→</i>',
    '<span>速度环 500 Hz</span><i>→</i><span>位置环 200 Hz</span>',
    '<em>目标频率 · USB 遥测 100 Hz · 图线仅作显示平滑，原始遥测 / CSV 不变</em></div>',
    '<div class="status">',
    metric('输出轴多圈位置', 'multi'), metric('输出轴速度', 'velocity'), metric('母线', 'bus'),
    metric('实测电流', 'current'), metric('电流目标', 'currentTarget'),
    metric('PWM 指令', 'pwm'), metric('nFAULT', 'fault'), metric('采样 / 绘图', 'rate'),
    '</div>',
    '<div class="content loop-stack">',
    '<section class="knob-panel"><div class="knob-setup"><h3>电流力反馈旋钮</h3>',
    '<p class="hint">选择手感 → 调滑块 → 启用 → 用手转动输出轴。调参数不会自行启动。</p>',
    '<div class="row"><select data-knob-effect aria-label="旋钮手感">',
    '<option value="0">连续卡点 / 力孔</option><option value="1">弹性回中</option>',
    '<option value="2">纯阻尼</option><option value="3">卡点 + 两端软限位</option></select>',
    '<button data-act="knobStart" class="primary" disabled>启用旋钮</button>',
    '<button data-act="knobStop" class="danger">STOP 停力</button></div>',
    '<div class="compact-sliders">',
    slider('knobSpacing', '输出轴卡点间距 / 回中柔度', 2, 90, .5, 15),
    slider('knobStrength', '吸附强度（绕组电流峰值）', 0, 600, 5, 500),
    slider('knobLever', '手柄力臂（轴心到施力点；仅换算）', 10, 100, 1, 25),
    slider('knobDamping', '输出轴粘性阻尼', 0, 10, .05, 1),
    slider('knobRange', '软限位半范围（对齐到整卡点）', 15, 720, 1, 90),
    '</div><p data-knob-force class="hint">手端力：等待读取板端电气模型；不是实测力传感器</p>',
    '<p data-knob-status class="hint">待烧录旋钮固件 · 未启用</p>',
    '<p class="hint">启用时把当前位置设为中心；总电流 ≤ 0.6 A，失联 1 s 停力，单次最多 60 s。软限位不是机械限位。</p></div>',
    '<div class="knob-preview"><strong>理论力曲线 · 非实测</strong><canvas data-knob-preview></canvas>',
    '<small>横轴：相对中心的输出轴位置；纵轴：静态电流。阻尼只在转动时起作用。</small></div></section>',
    '<div class="loop-block position-block">', chart('multi', true),
    '<section class="loop-controls"><h3>③ 位置环 · 200 Hz</h3>',
    slider('positionTarget', '目标多圈位置（输出轴）', -36000, 36000, 'any', 0),
    targetWindow('positionTarget'),
    '<div class="compact-sliders">',
    slider('positionKp', '位置 Kp（°/s/°）', 0, 20, 0.05, 1),
    slider('positionKi', '位置 Ki（°/s/(°·s)）', 0, 2, 0.005, 0),
    slider('positionKd', '位置 Kd（°/s/(°/s)）', 0, 5, 0.01, 0),
    slider('positionMaxVelocity', '输出轴最大速度', 100, 60000, 100, 6000),
    slider('positionMinVelocity', '输出轴脱困最小速度', 0, 60000, 100, 0),
    slider('positionDeadband', '输出轴到位死区', 0.1, 10, 0.1, 3),
    slider('positionLowSpeedCurrent', '低速前进电流下限 A', 0, 7, 0.05, 2),
    '</div><label><input type="checkbox" data-hold> 到位后持续保持（STOP 可停止）</label>',
    '<div class="row"><button data-act="holdZero" class="primary">保持输出轴零位</button>',
    '<button data-act="positionTest">输出轴 1 圈往返测试</button></div>',
    '<p class="hint">滑动目标即发送。页面全部角度和速度按减速比换算为输出轴坐标；后轴编码器不能测出减速箱齿隙。已调好的板端三环算法和参数保持不变。</p></section></div>',
    '<div class="loop-grid">',
    '<div class="loop-block">', chart('velocity'),
    '<section class="loop-controls"><h3>② 速度环 · 500 Hz</h3>',
    slider('velocityTarget', '输出轴目标速度', -60000, 60000, 100, 0),
    targetWindow('velocityTarget'),
    slider('velocityDuration', '单次持续时间', 0.1, 30, 0.1, 3),
    '<div class="compact-sliders">',
    slider('velocityKp', '速度 Kp', 0, 0.005, 0.00001, 0.0005),
    slider('velocityKi', '速度 Ki', 0, 0.02, 0.00001, 0.001),
    slider('velocityMaxCurrent', '最大电流 A', 0.1, 4.8, 0.05, 2.5),
    slider('velocityFriction', '静止脱困电流 A', 0, 4.8, 0.01, 1.2),
    '</div><p class="hint">速度环输出电流目标；同向改速连续更新，不先回零。加减速斜率由电机档案自动选择，接近目标时软化，避免高速响应换来目标附近抖动。</p></section></div>',
    '<div class="loop-block">', chart('current'),
    '<section class="loop-controls"><h3>① 电流环 · 2 kHz</h3>',
    slider('currentTarget', '目标电流（诊断）', -7000, 7000, 10, 0),
    targetWindow('currentTarget'),
    slider('currentDuration', '单次持续时间', 0.1, 10, 0.1, 1),
    '<div class="compact-sliders">',
    slider('currentKp', 'Kp（PWM/A）', 0, 5000, 1, 400),
    slider('currentKi', 'Ki（PWM/(A·s)）', 0, 2000000, 10, 1800),
    slider('currentMaxPwm', '电流环最大 PWM', 1, 4095, 1, 4095),
    '</div><p class="hint">这是电机绕组电流，不等于电源平均输入电流。INA240A1 ×20、10 mΩ。36GP-555 默认外环上限 0.6 A，2 A 仅为调试软件上限，并非电机连续额定值；板级限流不能替代电机温升验证。</p></section></div>',
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

function usbBoardIdentity(info) {
  const serial=(info.hwid||'').match(/\bSER=([^\s]+)/i)?.[1];
  return serial?serial.replace(/[:-]/g,'').toUpperCase():null;
}
function retireBoard(board) {
  board.retired=true;clearMotionTimers(board);board.motionGeneration++;
  board.activeMotion=null;board.active=false;board.driverReady=false;
  board.events?.close();board.events=null;
  board.root.remove();boards.delete(board.port);
  if(typeof quickRun!=='undefined' && quickRun?.targets.includes(board))quickStop().catch(()=>{});
  if(forceSession.active && forceSession.boards.includes(board))stopForceFeedback().catch(()=>{});
}
function ensureBoard(info) {
  const identity=usbBoardIdentity(info);
  // Recreate state: never migrate timers, gains or motion across USB sessions.
  for(const old of [...boards.values()]) {
    const oldIdentity=usbBoardIdentity(old);
    if((identity && oldIdentity===identity && old.port!==info.port) ||
       (old.port===info.port && identity && oldIdentity && identity!==oldIdentity))retireBoard(old);
  }
  let board = boards.get(info.port);
  if (!board) {
    board = initialBoard(info.port);
    boards.set(info.port, board);
    $('#boards').insertAdjacentHTML('beforeend', boardHtml(board));
    bindBoard(board);
    $('[data-act="recoverLink"]', board.root).addEventListener('click', async event => {
      event.stopPropagation();
      event.currentTarget.disabled = true;
      try { await recoverConnection(board); }
      catch (error) { reportLinkIssue(board.port, error.message); }
      finally { $('[data-act="recoverLink"]', board.root).disabled = false; }
    });
  }
  const wasActive = board.active;
  board.active = Boolean(info.active);
  board.writeOk = Boolean(info.write_ok);
  board.hwid = info.hwid || info.description || '';
  board.rxAgeMs = info.rx_age_ms;
  board.root.classList.remove('disconnected');
  if (info.rx_age_ms !== null && info.rx_age_ms < 2500) {
    board.noTelemetryWarned = false;
  }
  if (!wasActive && board.active) {
    board.configApplied = false;
    board.driverReady = false;
    board.noTelemetryWarned = false;
    board.motionGeneration += 1;
    board.seq = 0;
  }
  if (wasActive && !board.active) {
    Object.values(board.timers).forEach(clearTimeout);
    board.driverReady = false;
    board.motionGeneration += 1;
    if (board.activeMotion) reportLinkIssue(board.port, 'USB 会话已断开，动作续发已取消；恢复后需重新给目标。');
    board.activeMotion = null;
  }
  $('.dot', board.root).classList.toggle('on', board.active && board.writeOk);
  const linkText = !board.active ? '未连接' : !board.writeOk
    ? '已枚举 · CDC 写端点异常'
    : info.rx_age_ms === null
      ? '已连接 · 等待首帧'
      : info.telemetry_ok ? '已连接' : '已连接 · 遥测中断';
  $('[data-connected]', board.root).textContent = linkText;
  $('[data-hwid]', board.root).textContent = board.hwid + (info.last_error ? ' · ' + info.last_error : '');
  return board;
}

function setSlider(board, name, value) {
  const input = $('[data-slider="' + name + '"]', board.root);
  if (!input) return;
  input.value = value;
  updateSliderOutput(board, input);
}

function setSliderRange(board, name, min, max, step, value) {
  const input = $('[data-slider="' + name + '"]', board.root);
  if (!input) return;
  input.min = min;
  input.max = max;
  input.step = step;
  input.value = clamp(value, Number(min), Number(max));
  updateSliderOutput(board, input);
}

function applyMotorProfileUi(board, profile, gear = profile === '36gp555' ? 5.2 : 1) {
  if (board.motorProfile && (board.motorProfile !== profile || board.gear !== gear)) board.modelKe = null;
  board.motorProfile = profile;
  board.gear = gear;
  gearOf(board);
  // Reset range scales before profile changes, then convert exactly once.
  setSliderRange(board, 'velocityKp', 0, .005, .00001, .0005);
  setSliderRange(board, 'velocityKi', 0, .02, .00001, .001);
  setSliderRange(board, 'positionDeadband', .05, 10, .05, .1);
  board.appliedCommands = {};
  board.positionHold = profile === '36gp555';
  board.positionAcceleration = profile === '36gp555' ? 40000 : profile === '25ga370' ? 30000 : 100000;
  $('[data-hold]', board.root).checked = board.positionHold;
  const select = $('[data-profile]', board.root);
  if (select) select.value = profile;
  if (profile === '36gp555') {
    const hasBus = Number.isFinite(board.latest.bus) && board.latest.bus >= 2;
    const bus = hasBus ? board.latest.bus : 20.0;
    const voltagePwm = clamp(Math.floor(25.2 / bus * 4095), 1, 4095);
    setSliderRange(board, 'velocityTarget', -48000, 48000, 10, 0);
    setSliderRange(board, 'positionMaxVelocity', 100, 5400, 100, 5400);
    setSliderRange(board, 'positionMinVelocity', 0, 48000, 100, 0);
    setSliderRange(board, 'currentTarget', -2000, 2000, 10, 0);
    setSliderRange(board, 'velocityMaxCurrent', 0.05, 2, 0.05, (board.motorSettings?.current ?? 1.5)*0.8);
    setSliderRange(board, 'velocityFriction', 0, 2, 0.01, 0);
    setSliderRange(board, 'positionLowSpeedCurrent', 0, 2, 0.01, 0);
    setSliderRange(board, 'positionDeadband', 0.05, 10, 0.05, 0.10);
    setSlider(board, 'currentKp', 600);
    setSlider(board, 'currentKi', 600000);
    setSlider(board, 'currentMaxPwm', 4095);
    setSlider(board, 'velocityKp', 0.0008);
    setSlider(board, 'velocityKi', 0.016);
    setSlider(board, 'positionKp', 12);
    setSlider(board, 'positionKi', 0);
    setSlider(board, 'positionKd', 0.15);
    setSlider(board, 'positionDeadband', 0.10);
    board.velocityCurrentSlew = 80;
    board.velocityBrakeSlew = 1;
    setSlider(board, 'openPwm', 205);
    $('[data-profile-status]', board.root).textContent =
      '36GP-555 · 输出轴坐标 · 减速比 ' + gear + ':1 · 角度/速度 = 后轴 ÷ ' + gear + '（齿隙未测）';
  } else if (profile === '25ga370') {
    board.velocityCurrentSlew = 40;
    board.velocityBrakeSlew = 20;
    // Before the first telemetry frame the bus is unknown. Do not write an
    // illegal zero into the current-loop PWM slider; the firmware still
    // blocks motion until it measures a valid SS6952T VM rail. The motor
    // rated-voltage PWM limit is applied in firmware, independently of the
    // public 0..4095 current-loop range.
    const hasBus = Number.isFinite(board.latest.bus) && board.latest.bus >= 2;
    const bus = hasBus ? board.latest.bus : 8.0;
    const voltagePwm = clamp(Math.floor(6.3 / bus * 4095), 1, 4095);
    setSliderRange(board, 'velocityTarget', -4200, 4200, 10, 0);
    setSliderRange(board, 'positionMaxVelocity', 10, 4200, 10, 3600);
    setSliderRange(board, 'positionMinVelocity', 0, 4200, 5, 20);
    setSliderRange(board, 'currentTarget', -2000, 2000, 10, 0);
    setSliderRange(board, 'velocityMaxCurrent', 0.05, 4.8, 0.05, 2.5);
    setSliderRange(board, 'velocityFriction', 0, 4.8, 0.01, 1.2);
    setSliderRange(board, 'positionLowSpeedCurrent', 0, 4.8, 0.05, 2.0);
    setSlider(board, 'currentKp', 450);
    setSlider(board, 'currentKi', 1800);
    setSlider(board, 'currentMaxPwm', 4095);
    setSlider(board, 'velocityKp', 0.0015);
    setSlider(board, 'velocityKi', 0.002);
    setSlider(board, 'positionKp', 8);
    setSlider(board, 'positionKi', 0);
    setSlider(board, 'positionKd', 0.5);
    setSlider(board, 'positionDeadband', 0.5);
    setSlider(board, 'openPwm', Math.min(410, voltagePwm));
    $('[data-profile-status]', board.root).textContent = hasBus && bus < 8
      ? '6 V / 620 RPM · SS6952T 母线 ' + fmt(bus, 2) + ' V，不足 8.0 V，禁止动作'
      : hasBus
        ? '6 V / 620 RPM · 当前母线 ' + fmt(bus, 2) + ' V · 电机电压限制 ' + voltagePwm + '/4095 · 电流环量程 4095'
        : '6 V / 620 RPM · 等待母线遥测 · 电流环量程 4095';
  } else {
    board.velocityCurrentSlew = 30;
    board.velocityBrakeSlew = 30;
    setSliderRange(board, 'velocityTarget', -60000, 60000, 100, 0);
    setSliderRange(board, 'positionMaxVelocity', 100, 60000, 100, 6000);
    setSliderRange(board, 'positionMinVelocity', 0, 60000, 100, 0);
    setSliderRange(board, 'currentTarget', -7000, 7000, 10, 0);
    setSliderRange(board, 'velocityMaxCurrent', 0.1, 7, 0.05, 4.8);
    setSliderRange(board, 'velocityFriction', 0, 5, 0.01, 2.2);
    setSliderRange(board, 'positionLowSpeedCurrent', 0, 7, 0.05, 2);
    setSlider(board, 'currentKp', 400);
    setSlider(board, 'currentKi', 1800);
    setSlider(board, 'currentMaxPwm', 4095);
    setSlider(board, 'velocityKp', 0.0005);
    setSlider(board, 'velocityKi', 0.001);
    setSlider(board, 'positionKp', 4);
    setSlider(board, 'positionKi', 0);
    setSlider(board, 'positionKd', 0.25);
    setSlider(board, 'positionDeadband', 0.1);
    setSlider(board, 'openPwm', 205);
    $('[data-profile-status]', board.root).textContent = '775 · 12–24 V · 高速档案';
  }
  for (const name of [...ANGLE_PARAMS, ...SPEED_GAINS]) {
    const input = $('[data-slider="' + name + '"]', board.root);
    const convert = value => parameterFromMotor(board, name, Number(value));
    setSliderRange(board, name, convert(input.min), convert(input.max), 'any', convert(input.value));
  }
  configureTargetWindows(board);
  board.configApplied = false;
  board.configGeneration += 1;
}

function bindBoard(board) {
  board.root = document.querySelector('[data-port="' + board.port + '"]');
  $('[data-knob-effect]', board.root).addEventListener('change', () => scheduleKnobConfig(board));
  board.canvases = {};
  board.root.querySelectorAll('[data-window]').forEach(select => {
    select.addEventListener('change', () => setTargetWindow(board, select.dataset.window, Number(select.value)));
  });
  $('[data-hold]', board.root).addEventListener('change', event => {
    board.positionHold = event.target.checked;
    board.configApplied = false;
    board.configDirty = true;
    board.configGeneration += 1;
    scheduleConfig(board);
  });
  board.root.querySelectorAll('[data-chart]').forEach(section => {
    board.canvases[section.dataset.chart] = $('canvas', section);
  });
  board.root.querySelectorAll('[data-slider]').forEach(input => {
    input.addEventListener('input', () => {
      const name = input.dataset.slider;
      updateSliderOutput(board, input);
      if (name === 'knobLever') updateKnobStatus(board);
      else if (name.startsWith('knob')) scheduleKnobConfig(board);
      if (MOTION_SLIDERS[name]) scheduleMotion(board, MOTION_SLIDERS[name], Number(input.value));
      if (PARAM_SLIDERS.has(name)) {
        board.configApplied = false;
        board.configDirty = true;
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
  drawKnobPreview(board);
}

function updateSliderOutput(board, input) {
  const output = $('[data-out="' + input.dataset.slider + '"]', board.root);
  if (output) output.textContent = sliderText(input.dataset.slider, Number(input.value));
}

function sliderText(name, value) {
  if (name === 'knobSpacing' || name === 'knobRange') return fmt(positionValue(value), displayUnit === 'rev' ? 5 : 1) + ' ' + positionUnit();
  if (name === 'knobStrength') return Math.round(value) + ' mA';
  if (name === 'knobLever') return Math.round(value) + ' mm';
  if (name === 'knobDamping') return fmt(value * (displayUnit === 'rev' ? 360 : 1), 2) + ' mA/' + (displayUnit === 'rev' ? 'rps' : '(°/s)');
  if (name === 'positionTarget') return fmt(positionValue(value), displayUnit === 'rev' ? 6 : 2) + ' ' + positionUnit();
  if (name === 'velocityTarget') return fmt(velocityValue(value), displayUnit === 'rev' ? 4 : 1) + ' ' + velocityUnit();
  if (name === 'currentTarget') return Math.round(value) + ' mA';
  if (name === 'velocityDuration' || name === 'currentDuration') return fmt(value, 1) + ' s';
  if (name === 'openPwm' || name === 'currentMaxPwm') return Math.round(value) + ' / 4095 · ' + fmt(value / 40.95, 1) + '%';
  if (name === 'velocityMaxCurrent' || name === 'velocityFriction') return fmt(value, 2) + ' A';
  if (name === 'positionLowSpeedCurrent') return fmt(value, 2) + ' A';
  if (name === 'positionMaxVelocity' || name === 'positionMinVelocity') return fmt(velocityValue(value), displayUnit === 'rev' ? 4 : 2) + ' ' + velocityUnit();
  if (name === 'positionDeadband') return fmt(positionValue(value), displayUnit === 'rev' ? 7 : 4) + ' ' + positionUnit();
  if (name === 'velocityKp' || name === 'velocityKi') {
    const unit = displayUnit === 'rev' ? 'rps' : '°/s';
    return fmt(value * (displayUnit === 'rev' ? 360 : 1), 5) +
      (name === 'velocityKp' ? ' A/(' + unit + ')' : ' A/(' + unit + '·s)');
  }
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
  // Latest-value throttle, not a trailing debounce: continuous dragging must
  // send while the pointer moves, rather than wait until it stops. Only one
  // ACK transaction is in flight; old targets never build up in a queue.
  board.pendingMotion = {mode, value, generation:++board.motionGeneration};
  queueMotionFlush(board);
}

function queueMotionFlush(board) {
  if (board.motionFlushing || board.timers.motionDispatch || !board.pendingMotion) return;
  board.timers.motionDispatch = setTimeout(async () => {
    delete board.timers.motionDispatch;
    const pending = board.pendingMotion;
    board.pendingMotion = null;
    if (!pending || !board.active) return;
    board.motionFlushing = true;
    board.lastMotionFlushAt = Date.now();
    try { await runMotion(board, pending.mode, pending.value, pending.generation); }
    catch (error) { toast(error.message, true); }
    finally { board.motionFlushing = false; queueMotionFlush(board); }
  }, Math.max(0, 25 - (Date.now() - board.lastMotionFlushAt)));
}

async function applyCascade(board, notify = true) {
  if (!board.active) return;
  if (!board.motorProfile) throw new Error('尚未读取板端电机档案，未下发控制参数');
  if (board.configPromise) await board.configPromise;
  if (board.configApplied) {
    if (notify) toast(board.port + ': 三环参数已应用');
    return;
  }
  const generation = board.configGeneration;
  const commands = [
    'cascade current ' + valueOf(board, 'currentKp') + ' ' +
      valueOf(board, 'currentKi') + ' ' + valueOf(board, 'currentMaxPwm'),
    'cascade velocity ' + parameterToMotor(board, 'velocityKp') + ' ' +
      parameterToMotor(board, 'velocityKi') + ' ' + valueOf(board, 'velocityMaxCurrent') + ' ' +
      valueOf(board, 'velocityFriction') + ' ' +
      (board.velocityCurrentSlew || 30) + ' ' +
      (board.velocityBrakeSlew || 30),
    'cascade position ' + valueOf(board, 'positionKp') + ' ' +
      valueOf(board, 'positionKi') + ' ' + valueOf(board, 'positionKd') + ' ' +
      parameterToMotor(board, 'positionMaxVelocity') + ' ' + parameterToMotor(board, 'positionDeadband') + ' ' +
      parameterToMotor(board, 'positionMinVelocity') + ' ' + board.positionAcceleration + ' 1',
    'cascade low_speed_current ' + valueOf(board, 'positionLowSpeedCurrent'),
    'cascade hold ' + (board.positionHold ? 'on' : 'off'),
  ];
  const transaction = (async () => {
    for (const command of commands) {
      const key = command.split(' ')[1];
      if (board.appliedCommands[key] === command) continue;
      await send(board.port, command);
      board.appliedCommands[key] = command;
    }
  })();
  board.configPromise = transaction;
  try {
    await transaction;
    board.configApplied = generation === board.configGeneration;
    if (board.configApplied) board.configDirty = false;
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
  board.pendingMotion = null;
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
  if (forceSession.active || $('#forceStart').disabled) throw new Error('请先停止双板力反馈，再使用单轴控制');
  if (!board.active) return;
  gearOf(board);
  if (generation !== board.motionGeneration) return;
  if (!board.lastTelemetryAt || Date.now() - board.lastTelemetryAt > 500) {
    throw new Error(board.port + ': 角度/电流遥测已过期，未执行动作');
  }
  if (board.powerFault) {
    throw new Error(board.port + ': 功率通路故障已锁定，请先检查电机输出线/驱动通路，再点弹窗中的恢复按钮');
  }
  // The motor's rated voltage is not the SS6952T VM supply requirement. The
  // board driver is specified for an 8..50 V VM rail, so a 6 V reading is an
  // invalid driver supply even when the selected motor profile is 6 V.
  const busFloor = 8.0;
  if (!Number.isFinite(board.latest.bus) || board.latest.bus < busFloor) {
    throw new Error(board.port + ': 电机母线仅 ' + fmt(board.latest.bus, 2) +
      ' V，欠压，未执行动作（要求 ≥ ' + busFloor.toFixed(1) + ' V）');
  }
  if (!board.latest.fault) {
    throw new Error(board.port + ': nFAULT=0，未执行动作');
  }
  if (board.activeMotion?.mode === 'knob') { board.activeMotion = null; await send(board.port, 'stop'); }
  await ensureReady(board);
  if (generation !== board.motionGeneration) return;
  const timeoutMs = mode === 'velocity'
    ? Math.round(clamp(valueOf(board, 'velocityDuration'), 0.1, 30) * 1000)
    : mode === 'current'
      ? Math.round(clamp(valueOf(board, 'currentDuration'), 0.1, 10) * 1000)
      : 30000;
  value = Number(value.toFixed(mode === 'position' ? 3 : 2));
  if (mode === 'position') await send(board.port, positionCommand(board, value, timeoutMs));
  if (mode === 'velocity') await send(board.port, 'velocity ' + serialNumber(value * gearOf(board)) + ' 4095 ' + timeoutMs);
  if (mode === 'current') await send(board.port, 'current ' + value + ' 4095 ' + timeoutMs);
  if (generation !== board.motionGeneration || !board.active) return;
  board.activeMotion = { mode, value, timeoutMs };
  board.lastMotionSentAt = Date.now();
}

async function renewMotion(board) {
  if (!board.active || !board.activeMotion) return;
  if (board.activeMotion.mode === 'knob') return renewKnob(board);
  const { mode, value, timeoutMs = 30000 } = board.activeMotion;
  if (mode !== 'position') {
    if (Date.now() - board.lastMotionSentAt >= timeoutMs) board.activeMotion = null;
    return;
  }
  if (Date.now() - board.lastMotionSentAt < 10000) return;
  if (Date.now() - board.lastTelemetryAt > 500) {
    board.activeMotion = null;
    await send(board.port, 'stop');
    throw new Error(board.port + ': 遥测中断，停止位置保持');
  }
  if (!board.latest.fault || !board.latest.awake) {
    const reason = !board.latest.fault ? 'nFAULT=0' : '驱动已休眠';
    board.activeMotion = null;
    showErrorModal(board.port + ' 控制已停止', reason,
      '这是硬故障或驱动状态变化，不会自动重启。排除原因后重新拖动滑块。', board.port + ':' + reason);
    return;
  }
  const command = mode === 'position' ? positionCommand(board, value) :
    mode === 'velocity' ? 'velocity ' + value + ' 4095 30000' :
      'current ' + value + ' 4095 30000';
  try {
    await send(board.port, command);
    board.lastMotionSentAt = Date.now();
  } catch (error) {
    board.activeMotion = null;
    if (error.kind === 'transport') reportLinkIssue(board.port, '控制续发已取消：' + error.message);
    else if (error.kind !== 'cancelled') showErrorModal(board.port + ' 控制续租失败', error.message,
      '命令未续租；排除原因后重新拖动目标。', board.port + ':renew');
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
    't_ms', 'output_single_deg', 'output_multi_deg', 'output_target_deg', 'output_error_deg',
    'output_velocity_deg_s', 'output_velocity_target_deg_s', 'current_measured_A', 'current_target_A',
    'bus_V', 'pwm_signed', 'pwm_abs', 'nFAULT', 'awake', 'control', 'settled', 'gear_ratio'
  ];
  const rows = board.samples.map(sample => [
    sample.t, sample.single, sample.multi, sample.multiTarget,
    sample.multiTarget - sample.multi, sample.velocity, sample.velocityTarget,
    sample.current, sample.currentTarget, sample.bus, sample.pwm,
    sample.pwmMagnitude, sample.fault, sample.awake, sample.control, sample.settled, sample.gear
  ]);
  const csv = [keys.join(','), ...rows.map(row => row.map(v => Number.isFinite(v) ? v : '').join(','))].join('\r\n');
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
    if (action === 'knobStart') await startKnob(board);
    if (action === 'knobStop') await stopAndPrepare(board);
    if (action === 'connect') await connectOrRecover(board.port);
    if (action === 'applyProfile') {
      const profile = $('[data-profile]', board.root).value;
      clearMotionTimers(board);
      board.motionGeneration += 1;
      board.activeMotion = null;
      board.driverReady = false;
      await send(board.port, 'stop');
      await send(board.port, 'motorprofile ' + profile);
      applyMotorProfileUi(board, profile);
      await applyCascade(board, false);
      await send(board.port, 'motorprofile status');
      toast(board.port + ': 已应用 ' + (profile === '25ga370' ? '25GA-370 6V/620RPM' :
        profile === '36gp555' ? '36GP-555 24V/1538RPM 1:5.2' : '775') + ' 档案');
    }
    if (action === 'stop') await stopAndPrepare(board);
    if (action === 'zero') {
      clearMotionTimers(board); board.activeMotion = null; board.motionGeneration += 1;
      await send(board.port, 'stop'); await send(board.port, 'encreset');
    }
    if (action === 'clear') {
      board.samples.length = 0;
      resetChartRanges(board, board.latest);
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
    if (error.kind === 'cancelled') return;
    if (error.kind === 'transport') { reportLinkIssue(board.port, error.message); return; }
    toast(board.port + ': ' + error.message, true);
    showErrorModal(board.port + ' 操作失败', error.message, undefined,
      board.port + ':action:' + error.message);
  }
}

function knobSettings(board) {
  return { effect: Number($('[data-knob-effect]', board.root).value),
    spacing: valueOf(board, 'knobSpacing'), peak: valueOf(board, 'knobStrength'),
    damping: valueOf(board, 'knobDamping'), range: valueOf(board, 'knobRange') };
}

function knobConfigCommand(board) {
  const c = knobSettings(board);
  return 'knob config ' + [c.effect, c.spacing, c.peak, c.damping, c.range].map(serialNumber).join(' ');
}

function scheduleKnobConfig(board) {
  const range = $('[data-slider="knobRange"]', board.root);
  range.min = valueOf(board, 'knobSpacing');
  updateSliderOutput(board, range);
  drawKnobPreview(board);
  clearTimeout(board.timers.knobConfig);
  // An offline edit is only a local preview. Never wake/start/keep here.
  if (board.activeMotion?.mode !== 'knob') return;
  const token = board.activeMotion.token;
  board.timers.knobConfig = setTimeout(async () => {
    if (board.activeMotion?.token !== token) return;
    try { await send(board.port, knobConfigCommand(board)); }
    catch { if (board.activeMotion?.token === token) { board.activeMotion = null; await send(board.port, 'stop').catch(() => {}); } }
  }, 150);
}

async function startKnob(board) {
  if (forceSession.active || $('#forceStart').disabled) throw new Error('请先停止双板力反馈');
  gearOf(board);
  if (!board.active || !board.knobSupported || board.motorProfile !== '36gp555') {
    throw new Error('旋钮尚未就绪：需要连接 36GP-555，并烧录 0.5.0 或更新的旋钮固件');
  }
  if (document.hidden || !board.lastTelemetryAt || Date.now() - board.lastTelemetryAt > 500 ||
      !board.latest.fault || board.powerFault || !(board.latest.bus >= 8 && board.latest.bus <= 50)) {
    throw new Error('尚未通电或遥测/驱动状态无效，旋钮未启用');
  }
  if (Math.abs(board.latest.velocity) > 30) throw new Error('请先停住输出轴，再启用旋钮');
  clearMotionTimers(board);
  board.activeMotion = null;
  const generation = ++board.motionGeneration;
  await send(board.port, 'stop');
  if (generation !== board.motionGeneration) return;
  await ensureReady(board);
  if (generation !== board.motionGeneration) return;
  await send(board.port, knobConfigCommand(board));
  if (generation !== board.motionGeneration) return;
  const token = 1 + crypto.getRandomValues(new Uint32Array(1))[0] % 1000000000;
  const response = await send(board.port, 'knob start ' + token);
  if (generation !== board.motionGeneration) return;
  const origin = response.reply?.match(/origin_out_deg=([+-]?[\d.]+)/);
  board.knobOrigin = origin ? Number(origin[1]) : board.latest.multi;
  board.activeMotion = { mode: 'knob', token, startedAt: Date.now() };
  board.lastMotionSentAt = Date.now();
  board.knobNotice = '';
  updateKnobStatus(board);
}

async function renewKnob(board) {
  const motion = board.activeMotion;
  if (motion?.mode !== 'knob' || board.knobRenewing || Date.now() - board.lastMotionSentAt < 250) return;
  if (document.hidden || Date.now() - board.lastTelemetryAt > 500 ||
      !board.latest.fault || !board.latest.awake || Date.now() - motion.startedAt >= 59000) {
    board.activeMotion = null;
    board.knobNotice = '已停力：页面隐藏、遥测中断或本次试用到期；不会自动重启';
    await send(board.port, 'stop');
    return;
  }
  board.knobRenewing = true;
  try {
    // Handle a STOP racing the acknowledgement without showing a stale modal.
    const response = await api('send', {port: board.port, command:'knob keep ' + motion.token, wait_ack:true,
      session_id:board.sessionId || undefined});
    if (!response.acknowledged) throw new Error('旋钮续租未确认');
    if (board.activeMotion === motion) board.lastMotionSentAt = Date.now();
  } catch (error) {
    if (board.activeMotion === motion) {
      board.activeMotion = null;
      await send(board.port, 'stop').catch(() => {});
      reportLinkIssue(board.port, '旋钮已停力：' + error.message + '；恢复后需手动启用。');
    }
  } finally { board.knobRenewing = false; }
}

function updateKnobStatus(board) {
  const supported = board.knobSupported && board.motorProfile === '36gp555';
  $('[data-act="knobStart"]', board.root).disabled = !board.active || !supported || board.activeMotion?.mode === 'knob';
  const c = knobSettings(board);
  const leverM = valueOf(board, 'knobLever') / 1000;
  const torquePerAmp = Number.isFinite(board.modelKe) && board.modelKe > 0 && board.gear >= 1
    ? board.modelKe * board.gear : null;
  const force = $('[data-knob-force]', board.root);
  if (force) force.textContent = torquePerAmp && leverM > 0
    ? '模型理想值（忽略减速箱损耗）：峰值 ' + fmt(torquePerAmp * c.peak / 1000 / leverM, 2) +
      ' N / ' + fmt(torquePerAmp * c.peak / 1000, 3) + ' N·m；力臂 ' + fmt(leverM * 1000, 0) +
      ' mm。非实测手力，实际效果受齿隙、摩擦及电流跟踪影响。'
    : '杆端力：等待本板 Ke 模型回读，暂不能估算。';
  const end = Math.floor(c.range / c.spacing) * c.spacing;
  const cells = c.effect === 3 ? '软限位 ±' + fmt(positionValue(end), 4) + ' ' + positionUnit() :
    '每圈约 ' + fmt(360 / c.spacing, 1) + ' 个卡点';
  const state = board.activeMotion?.mode === 'knob'
    ? '已启用 · 中心 ' + fmt(positionValue(board.knobOrigin), 5) + ' ' + positionUnit() +
      ' · 电流目标 ' + fmt(board.latest.currentTarget * 1000, 0) +
      ' / 实测 ' + fmt(board.latest.current * 1000, 0) + ' mA'
    : board.knobNotice || '未启用（调参数不会产生输出）';
  $('[data-knob-status]', board.root).textContent = !supported ? '待烧录旋钮固件 / 36GP-555 档案 · 当前只预览' : state + ' · ' + cells;
  const canvas = $('[data-knob-preview]', board.root);
  if (board.knobPreviewWidth !== Math.round(canvas.getBoundingClientRect().width)) drawKnobPreview(board);
}

// Static force-law preview only; no fabricated encoder/current observations.
function knobPreviewMa(c, x) {
  let force = 0;
  if (c.effect === 0 || c.effect === 3) {
    force = -c.peak * Math.sin(2 * Math.PI * (x / c.spacing - Math.round(x / c.spacing)));
    const end = Math.floor(c.range / c.spacing) * c.spacing;
    if (c.effect === 3 && Math.abs(x) > end) force = -c.peak * Math.tanh(4 * (x - clamp(x, -end, end)) / c.spacing);
  } else if (c.effect === 1) force = -c.peak * Math.tanh(x / c.spacing);
  return force;
}

function drawKnobPreview(board) {
  const canvas = $('[data-knob-preview]', board.root);
  const width = Math.max(240, Math.round(canvas.getBoundingClientRect().width));
  board.knobPreviewWidth = Math.round(canvas.getBoundingClientRect().width);
  const height = 190, dpr = devicePixelRatio || 1;
  canvas.width = width * dpr; canvas.height = height * dpr;
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const c = knobSettings(board);
  const span = c.effect === 3 ? c.range + c.spacing : c.spacing * 2;
  const left = 52, right = width - 16, top = 27, bottom = height - 30;
  const yScale = Math.max(100, c.peak * 1.15);
  ctx.clearRect(0, 0, width, height); ctx.font = '12px Consolas, Microsoft YaHei';
  ctx.lineWidth = 1; ctx.strokeStyle = '#294258'; ctx.fillStyle = '#a7bfce';
  for (let i = 0; i <= 4; i++) {
    const x = left + (right - left) * i / 4, y = top + (bottom - top) * i / 4;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(fmt(yScale * (1 - i / 2), 0), left - 7, y + 4);
    ctx.textAlign = 'center'; ctx.fillText(fmt(positionValue(span * (i / 2 - 1)), displayUnit === 'rev' ? 3 : 0), x, bottom + 19);
  }
  ctx.textAlign = 'left'; ctx.fillText('mA', 8, 15);
  ctx.textAlign = 'right'; ctx.fillText('输出轴 ' + positionUnit(), right, 15);
  ctx.strokeStyle = COLORS.current; ctx.lineWidth = 2; ctx.beginPath();
  for (let i = 0; i <= 400; i++) {
    const x = span * (i / 200 - 1), ma = knobPreviewMa(c, x);
    const px = left + (right - left) * i / 400, py = (top + bottom) / 2 - ma / yScale * (bottom - top) / 2;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

function numeric(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function parseLine(board, text) {
  const trace=text.match(/^T,(\d+),([+-]?[\d.]+),([+-]?[\d.]+),([+-]?[\d.]+)(?:,([+-]?[\d.]+),([+-]?[\d.]+),(\d+),([+-]?[\d.]+))?$/);
  if(trace) {
    if(board.currentTrace && board.currentTrace.length<1024) board.currentTrace.push(trace.slice(1).filter(v=>v!==undefined).map(Number));
    return;
  }
  if (text.startsWith('S,')) {
    if (!Number.isFinite(board.gear) || board.gear < 1) return;
    const part = text.split(',');
    if (part.length < 14) return;
    if (part.slice(1).some(value => value.trim() === '' || !Number.isFinite(Number(value)))) return;
    if (![0, 1].includes(Number(part[7])) || ![0, 1].includes(Number(part[8]))) return;
    const pwmMagnitude = numeric(part[6]);
    const phase = numeric(part[14]);
    const legacySigned = part.length > 15 ? numeric(part[15]) : (phase ? pwmMagnitude : -pwmMagnitude);
    const control = numeric(part[12]);
    const cascadePwm = part.length > 23 ? numeric(part[23], legacySigned) : legacySigned;
    const measuredCurrent = part.length > 22 ? numeric(part[22]) / 1000 : numeric(part[5]) / 1000;
    const sample = {
      t: numeric(part[1]),
      single: ((numeric(part[3]) / board.gear) % 360 + 360) % 360,
      multi: numeric(part[3]) / board.gear,
      gear: board.gear,
      bus: numeric(part[4]),
      current: measuredCurrent,
      pwm: cascadePwm,
      pwmMagnitude,
      fault: numeric(part[7]),
      awake: numeric(part[8]),
      step: numeric(part[9]),
      raw: numeric(part[10]),
      velocity: numeric(part[11]) / board.gear,
      control,
      forceActive: part.length>26 && numeric(part[26])===1,
      multiTarget: part.length>26 && numeric(part[26])===1 ? numeric(part[25])/board.gear : control === 3 || control === 5 ? numeric(part[13]) / board.gear : NaN,
      phase,
      settled: part.length > 19 ? numeric(part[19]) : 0,
      velocityTarget: part.length > 20 ? numeric(part[20]) / board.gear : 0,
      currentTarget: part.length > 21 ? numeric(part[21]) / 1000 : 0
    };
    if (sample.t === board.latest.t) return;
    board.lastTelemetryAt = Date.now();
    if (control === 0 && board.interactionWarning) {
      board.interactionWarning = null;
      if(sample.fault===1 && sample.pwm===0) {
        const health=$('[data-health]',board.root);
        health.textContent='已停止 · 输出归零'; health.className='health good';
      }
    }
    board.noTelemetryWarned = false;
    board.telemetryReconnects = 0;
    board.driverReady = sample.awake === 1;
    if (board.faultAlertsReady !== false && board.lastFault === 1 && sample.fault === 0) {
      board.activeMotion = null;
      showErrorModal(board.port + ' 驱动故障', 'nFAULT 从 1 变为 0，PWM 已停止。',
        '检查驱动过流、欠压、过温及电机输出线；排除后重新拖动滑块。', board.port + ':nfault');
    }
    if (board.faultAlertsReady !== false && board.lastAwake === 1 && sample.awake === 0 && board.activeMotion) {
      board.activeMotion = null;
      showErrorModal(board.port + ' 驱动休眠', '运行中 awake 从 1 变为 0。',
        '重新拖动滑块会自动 WAKE；若重复出现请检查复位和休眠线路。', board.port + ':sleep');
    }
    board.lastFault = sample.fault;
    board.lastAwake = sample.awake;
    if (board.samples.length && sample.t < board.samples[board.samples.length - 1].t) {
      board.samples.length = 0;
      board.rangeUpdatedAt = 0;
      clearMotionTimers(board);
      board.activeMotion = null;
      board.motionGeneration += 1;
      board.driverReady = false;
      board.latest = {};
      board.lastTelemetryAt = 0;
      board.motorProfile = null;
      board.gear = null;
      board.modelKe = null;
      board.outputPosition = false;
      board.knobSupported = false;
      board.configApplied = false;
      board.appliedCommands = {};
      showErrorModal(board.port + ' 控制器已重启',
        '检测到板端时间戳回退，已清除重启前的全部控制续租。',
        '旧位置、速度和电流目标不会自动恢复；确认状态后再手动操作。',
        board.port + ':controller-reboot');
      return;
    }
    board.latest = sample;
    if (board.activeMotion?.mode === 'knob' && sample.control !== 5 &&
        Date.now() - board.activeMotion.startedAt > 300) {
      board.activeMotion = null;
      board.knobNotice = '板端已离开旋钮模式，已停止续租';
    }
    if (board.activeMotion?.mode === 'position' && sample.settled === 1 && !board.positionHold) {
      board.activeMotion = null;
    }
    board.samples.push(sample);
    if (board.samples.length > 1200) board.samples.splice(0, board.samples.length - 1200);
    updateRanges(board);
    board.dirty = true;
    return;
  }
  if (text.startsWith('MODEL fw=')) {
    const ke = Number(text.match(/\bKe=([0-9.eE+-]+)V\//)?.[1]);
    board.modelKe = Number.isFinite(ke) && ke > 0 ? ke : null;
    updateKnobStatus(board);
  }
  const address = text.match(/BUS addr=(\d+)/);
  if (address) board.busAddress = Number(address[1]);
  const pong = text.match(/^BUS_RX from=(\d+) .*payload=PONG,addr=(\d+),uid=([0-9a-f]+)$/i);
  if (pong) {
    board.lastBusPong = { source: Number(pong[1]), address: Number(pong[2]), uid: pong[3], at: Date.now() };
  }
  if (text.startsWith('CAPS ')) {
    const changed = !board.outputPosition;
    board.outputPosition = /\boutput_position=1\b/.test(text);
    board.knobSupported = /\bknob=1\b/.test(text) && /\bhaptic_protocol=1\b/.test(text);
    board.interactionGuard = /\binteraction_guard=1\b/.test(text);
    if (changed && board.motorProfile) configureTargetWindows(board);
    updateKnobStatus(board);
  }
  const knobStart = text.match(/^OK knob_start token=\d+ origin_out_deg=([+-]?[\d.]+)/);
  if (knobStart) board.knobOrigin = Number(knobStart[1]);
  if (text.startsWith('KNOB stopped')) {
    board.activeMotion = null;
    board.knobNotice = '已停力：通信租期或 60 s 测试到期，需手动再次启用';
    updateKnobStatus(board);
  }
  const knobConfig = text.match(/^KNOB_CFG active=(\d+) effect=(\d+) spacing_out_deg=([+-]?[\d.]+) peak_mA=([+-]?[\d.]+) damping_mA_per_out_dps=([+-]?[\d.]+) range_out_deg=([+-]?[\d.]+)/);
  if (knobConfig) {
    const active = Number(knobConfig[1]) === 1;
    const effect = Number(knobConfig[2]);
    const spacing = Number(knobConfig[3]);
    const peak = Number(knobConfig[4]);
    const damping = Number(knobConfig[5]);
    const range = Number(knobConfig[6]);
    const effectSelect = $('[data-knob-effect]', board.root);
    if (effectSelect && [0, 1, 2, 3].includes(effect)) effectSelect.value = String(effect);
    if (Number.isFinite(spacing)) setSlider(board, 'knobSpacing', spacing);
    if (Number.isFinite(peak)) setSlider(board, 'knobStrength', peak);
    // Firmware reports mA per output deg/s; the UI stores A per deg/s.
    if (Number.isFinite(damping)) setSlider(board, 'knobDamping', damping / 1000);
    if (Number.isFinite(range)) setSlider(board, 'knobRange', range);
    board.knobConfigActive = active;
    updateKnobStatus(board);
  }
  const motorProfile = text.match(/^MOTOR_PROFILE id=(25ga370-6v-620rpm|36gp555-24v-1538rpm|775-12-24v).*voltage_pwm_limit=(\d+)\/4095/);
  if (motorProfile) {
    board.motorSettings = {
      voltage: Number(text.match(/rated_voltage=([\d.]+)/)?.[1]),
      current: Number(text.match(/current_limit=([\d.]+)/)?.[1]),
      gear: Number(text.match(/gear=([\d.]+)/)?.[1])
    };
    const settingsState = $('#motorSettingsState');
    if (settingsState && !settingsState.dataset.busy) settingsState.textContent =
      [...boards.values()].filter(b=>b.active && b.motorSettings).map(b=>
        `${b.port}：${b.motorSettings.voltage} V / ${b.motorSettings.current} A / ${b.motorSettings.gear}:1`).join('；') + '（板端值）';
    const profile = motorProfile[1].startsWith('25ga370') ? '25ga370' :
      motorProfile[1].startsWith('36gp555') ? '36gp555' : '775';
    const gear = Number(text.match(/gear=([\d.]+)/)?.[1]);
    if (!Number.isFinite(gear) || gear < 1) { board.gear = null; return; }
    if (board.motorProfile !== profile || board.gear !== gear) {
      board.samples = []; board.rangeUpdatedAt = 0; board.latest = {}; board.lastTelemetryAt = 0;
      board.activeMotion = null; board.motionGeneration += 1;
      applyMotorProfileUi(board, profile, gear);
    }
    const profileStatus = $('[data-profile-status]', board.root);
    if (profileStatus) {
      const bus=text.match(/bus=([\d.]+)V/)?.[1] || '—';
      profileStatus.textContent = profile === '36gp555'
        ? '36GP-555 · 母线 ' + bus + ' V · 全页为输出轴坐标 · 减速比 ' + gear + ':1（后轴推算，齿隙未测）'
        : profile + ' · 输出轴坐标 · 档案减速比 ' + gear + ':1';
    }
  }
  if (text.startsWith('CASCADE_CFG ') && board.motorProfile && !board.configDirty && !board.configPromise) {
    const n = '([+-]?[0-9.eE]+)';
    const update = (expression, names) => {
      const match = text.match(new RegExp(expression));
      if (!match) return;
      names.forEach((name, index) => setSlider(board, name, parameterFromMotor(board, name, Number(match[index+1]))));
    };
    update('current_hz=\\d+ kp='+n+' ki='+n+' max_pwm='+n, ['currentKp','currentKi','currentMaxPwm']);
    update('velocity_hz=\\d+ kp='+n+' ki='+n+' max_current='+n+'A friction='+n+'A', ['velocityKp','velocityKi','velocityMaxCurrent','velocityFriction']);
    update('position_hz=\\d+ kp='+n+' ki='+n+' kd='+n+' max_velocity='+n, ['positionKp','positionKi','positionKd','positionMaxVelocity']);
    update('deadband='+n+' low_speed_current='+n+'A', ['positionDeadband','positionLowSpeedCurrent']);
    const slew = text.match(/current_slew=([\d.]+)A\/s brake_slew_x=([\d.]+)/);
    if (slew) { board.velocityCurrentSlew=Number(slew[1]); board.velocityBrakeSlew=Number(slew[2]); }
    const accel = text.match(/acceleration=([\d.]+)/);
    if (accel) board.positionAcceleration=Number(accel[1]);
    // On connection, use the board's configuration instead of overwriting it
    // with browser defaults. Any subsequent slider edit marks it dirty.
    board.configApplied = true;
  }
  if (text.startsWith('CONTROL_STATS ') && !board.configDirty && !board.configPromise) {
    const hold = text.match(/hold=(\d)/);
    if (hold) { board.positionHold=hold[1]==='1'; $('[data-hold]', board.root).checked=board.positionHold; }
  }
  if (/CASCADE (?:no_current_response|no_power_response)|ERR power_path_fault_latched/.test(text)) {
    board.powerFault = true;
    board.activeMotion = null;
  }
  if (text.startsWith('OK recovered power_path_fault=0')) board.powerFault = false;
  if (text.startsWith('COGGING_CFG ')) {
    const compensation=text.match(/scale=([\d.]+) coulomb=([-\d.]+)A offset=([-\d.]+)A/);
    if(compensation&&compensation.slice(1).every(x=>Number.isFinite(Number(x))))
      board.rotorCompensation={scale:Number(compensation[1]),coulomb:Number(compensation[2]),offset:Number(compensation[3])};
    const scale = text.match(/scale=([\d.]+)/);
    $('[data-compensation]', board.root).textContent = scale && Number(scale[1]) > 0
      ? '角度扰动补偿：已载入本机实测校准 · 比例 ' + Number(scale[1]).toFixed(2) + ' · 修正电流 ≤ 0.3 A'
      : '角度扰动补偿：未启用；更换电机或磁铁安装位置后需要重新辨识';
  }
  if (text.startsWith('CONTROL_WARN ')) {
    const reason=text.match(/reason=(\w+)/)?.[1];
    const labels={speed_derating:'转动较快，正在减力；放慢后平滑恢复',supply_derating:'电源波动，正在减力',current_derating:'接近电流上限，正在限流',clear:'限制已解除，力矩正在平滑恢复'};
    const health=$('[data-health]',board.root);
    health.textContent='运行提示 · '+(labels[reason]||reason);
    health.className='health '+(reason==='clear'?'good':'warn');
    board.interactionWarning=reason==='clear'?null:health.textContent;
    if(forceSession.active) forceState(board.port+' · '+health.textContent,reason==='clear'?'good':'warn');
    return; // A warning NEVER cancels commands or requests STOP.
  }
  if (/^ERR (usage:|knob config|knob start requires STOP|knob invalid session token|.*outside limits)/.test(text)) {
    const health=$('[data-health]',board.root);
    health.textContent='输入未采用 · '+text;
    health.className='health warn';
    return; // A rejected edit is not evidence that the active controller stopped.
  }
  if (text.startsWith('CONTROL_COMPLETE mode=force')) {
    if(forceSession.active) stopForceFeedback().then(()=>forceState('本轮体验正常结束 · 非设备故障，可再次启动','good')).catch(e=>forceState(e.message,'bad'));
    return;
  }
  if (/^(DIAG|ERR|MODEL|MOTOR_PROFILE|CASCADE|CONTROL_STATS|BUS_|SYNC_|SYNC )/.test(text)) {
    const health = $('[data-health]', board.root);
    const encoderStale = text.match(/^CASCADE fault encoder_stale age_us=(\d+) limit_us=(\d+)/);
    const nearEncoderDeadline = encoderStale &&
      Number(encoderStale[1]) <= Number(encoderStale[2]) * 1.5;
    health.textContent = text.startsWith('CASCADE mode=')
      ? board.interactionWarning || ('板端模式 ' + (text.match(/mode=(\w+)/)?.[1] || '—') + ' · 当前图表均为输出轴坐标')
      : nearEncoderDeadline
        ? '编码器采样迟到保护：' + (Number(encoderStale[1]) / 1000).toFixed(1) + ' ms / ' +
           (Number(encoderStale[2]) / 1000).toFixed(1) + ' ms；PWM 已停，需核对采样链路'
        : text;
    health.className = 'health ' + (/^(ERR|CASCADE fault)/.test(text) && !nearEncoderDeadline ? 'bad' : nearEncoderDeadline || board.interactionWarning ? 'warn' : 'good');
    if (text.startsWith('CASCADE fault interaction') && board.faultAlertsReady !== false) {
      const reason=text.match(/reason=(\w+)/)?.[1];
      const labels={overspeed:'减力后仍超过最后速度边界',overcurrent:'过流确认保护（连续 5 秒或达到 5 A 紧急上限）',supply_fault:'电源超过允许边界',invalid_feedback:'反馈数据无效',oscillation:'检测到反复高速换向'};
      const detail=board.port+' · 已去力：'+(labels[reason]||reason)+'；检查后手动重新启动';
      forceState(detail,'bad');
      if(forceSession.active) stopForceFeedback().then(()=>forceState(detail,'bad')).catch(e=>forceState(detail+'；'+e.message,'bad'));
    }
    if (text.startsWith('CASCADE fault force_envelope') && board.faultAlertsReady !== false) {
      const reason=text.match(/reason=(\w+)/)?.[1];
      const label={overspeed:'输出轴超速',undervoltage:'母线跌落',overvoltage:'母线升高',overcurrent:'支路过流',lease_expired:'60 秒会话结束',invalid_speed:'速度数据无效'}[reason] || '旧固件未区分触发项';
      const detail=board.port+' · '+label+' · '+text;
      forceState(detail,'bad');
      if(forceSession.active) stopForceFeedback().then(()=>forceState(detail,'bad')).catch(error=>forceState(detail+'；'+error.message,'bad'));
    }
    if (/^(CASCADE|MODEL) timeout$/.test(text) && board.activeMotion?.mode !== 'position') {
      board.activeMotion = null;
      health.textContent = '限时测试正常结束；重新拖动目标开始下一次';
      return;
    }
    if (/^(ERR)|CASCADE (timeout|fault|bus_low|no_current_response|no_power_response)|MODEL timeout/.test(text)) {
      board.activeMotion = null;
      if (board.faultAlertsReady !== false) {
        if (text.startsWith('CASCADE fault force_envelope') || text.startsWith('CASCADE fault interaction')) {
          // Exact cause remains inline; never replace it with a generic modal.
        } else if (nearEncoderDeadline) {
          // A single near-deadline sample miss is still a real board-side
          // stop, but it is not useful as a blocking dialog. Keep the health
          // line and let the user retry after the controller has stopped.
          const noticeKey = board.port + ':encoder_stale_near_deadline';
          const now = Date.now();
          if (now - (issueShownAt.get(noticeKey) || 0) >= 30000) {
            issueShownAt.set(noticeKey, now);
            toast(board.port + ' 编码器采样迟到，已停机保护；可先重试一次', true);
          }
        } else if (text === 'CASCADE fault knob_invalid_or_overspeed') {
          // This is an intentional board-side overspeed guard. It must still
          // stop the motor, but a modal turns a deliberate hand-speed limit
          // into a recurring blocking popup when the retained log is replayed.
          board.knobNotice = '已停力：旋钮速度或配置/反馈无效；确认停稳和设备状态后重新启用';
          updateKnobStatus(board);
          toast(board.port + ' 旋钮反馈保护，已停力', true);
        } else {
          showErrorModal(board.port + ' 控制器报告异常', text,
            text.includes('timeout') ? '本次限时测试已结束；电流/速度不会自动续发，重新拖动滑块可开始下一次。' :
              '先排除提示的电源、nFAULT 或参数问题，再重新拖动滑块。', board.port + ':' + text);
        }
      }
    }
    if (text.startsWith('SYNC mode=force') && forceSession.active) {
      const state = $('#forceState');
      state.textContent = board.port + ' · ' + (board.interactionWarning || text);
      state.className = /\barmed=1\b/.test(text) ? (board.interactionWarning?'warn':'good') : 'bad';
    }
    if (text.startsWith('SYNC_STOP ') && forceSession.active) {
      stopForceFeedback().then(() => forceState(board.port + ' · 双板链路保护已停机：' + text, 'bad')).catch(error => forceState(error.message, 'bad'));
    }
    if (text.startsWith('SYNC_RECOVER ') && forceSession.active) {
      forceState(board.port + ' · 双板链路已恢复：' + text, 'good');
    }
  }
}

function rangeValues(board, key, samples) {
  const values = [];
  samples.forEach(sample => {
    // Keep position/velocity ranges in the firmware's degree units.  The
    // drawing path converts those values to turns/rps in axisRange(), just as
    // it does for the plotted samples.
    const measured = key === 'multi' ? sample.multi :
      key === 'velocity' ? sample.velocity : sample[key];
    if (Number.isFinite(measured)) values.push(measured);
    const target = key === 'multi' ? sample.multiTarget :
      key === 'velocity' ? sample.velocityTarget :
      key === 'current' ? sample.currentTarget : NaN;
    if (Number.isFinite(target)) values.push(target);
  });
  return values;
}

function calculateChartRange(key, values) {
  const config = CHART_SCALE[key];
  const finite = values.filter(Number.isFinite);
  if (!config || !finite.length) {
    const fallback = config?.minSpan || 1;
    return { min: -fallback / 2, max: fallback / 2 };
  }
  let low = Math.min(...finite);
  let high = Math.max(...finite);
  if (config.symmetric) {
    const peak = Math.max(Math.abs(low), Math.abs(high), config.minSpan / 2);
    low = -peak;
    high = peak;
  } else {
    const center = (low + high) / 2;
    const span = Math.max(config.minSpan, high - low);
    low = center - span / 2;
    high = center + span / 2;
  }
  const span = Math.max(config.minSpan, high - low);
  const padded = span * (1 + config.padding);
  const center = (low + high) / 2;
  low = center - padded / 2;
  high = center + padded / 2;
  if (config.symmetric) {
    const peak = Math.max(Math.abs(low), Math.abs(high), config.minSpan / 2);
    low = -peak;
    high = peak;
  }
  const quantum = config.quantum;
  return {
    min: Math.floor(low / quantum) * quantum,
    max: Math.ceil(high / quantum) * quantum
  };
}

function updateRanges(board) {
  const endTime = board.latest?.t;
  if (!Number.isFinite(endTime)) return;
  // Recompute at most every 100 ms. This is fast enough for a 100 Hz stream,
  // while quantised ranges prevent labels from dancing on every frame.
  if (endTime - board.rangeUpdatedAt < 100) return;
  board.rangeUpdatedAt = endTime;
  const visible = board.samples.filter(sample => sample.t >= endTime - 10000);
  Object.keys(CHART_SCALE).forEach(key => {
    const values = rangeValues(board, key, visible);
    if (values.length) board.range[key] = calculateChartRange(key, values);
  });
}

function resetChartRanges(board, sample = {}) {
  board.rangeUpdatedAt = 0;
  const values = {};
  Object.keys(CHART_SCALE).forEach(key => {
    const measured = key === 'multi' ? sample.multi :
      key === 'velocity' ? sample.velocity : sample[key];
    const target = key === 'multi' ? sample.multiTarget :
      key === 'velocity' ? sample.velocityTarget :
      key === 'current' ? sample.currentTarget : NaN;
    values[key] = [measured, target].filter(Number.isFinite);
    board.range[key] = calculateChartRange(key, values[key]);
  });
}

async function pollLogs(board) {
  if (!board.active || board.polling || board.eventsLive) return;
  board.polling = true;
  try {
    const result = await api('logs?port=' + encodeURIComponent(board.port) + '&since=' + board.seq);
    ingestLogs(board, result);
  } catch (_) {
    board.active = false;
  } finally {
    board.polling = false;
  }
}

function ingestLogs(board, result) {
    // /api/logs and the first SSE frame replay the current session's retained
    // history. Parse it for charts and state, but never surface an old fault as
    // a fresh modal. A new session is treated the same way until its backlog is
    // consumed; subsequent frames are live alerts.
    let suppressFaultAlerts = board.faultAlertsReady === false;
    if (result.session_id && result.session_id !== board.sessionId) {
      const restarted = board.sessionId !== null;
      suppressFaultAlerts = true;
      board.sessionId = result.session_id;
      board.seq = 0;
      board.faultAlertsReady = false;
      if (restarted) {
        clearMotionTimers(board);
        board.motionGeneration += 1;
        board.activeMotion = null;
        board.samples = [];
        board.rangeUpdatedAt = 0;
        board.latest = {};
        board.lastTelemetryAt = 0;
        board.configApplied = false;
        board.appliedCommands = {};
        board.motorProfile = null;
        board.gear = null;
        board.modelKe = null;
        board.knobSupported = false;
        board.outputPosition = false;
      }
    }
    result.logs.forEach(entry => {
      if (entry.seq <= board.seq) return;
      board.seq = Math.max(board.seq, entry.seq);
      if (entry.direction === 'rx') parseLine(board, entry.text);
      if (entry.direction === 'error') reportLinkIssue(board.port, '串口读写异常：' + entry.text);
      if (entry.direction === 'system' && entry.text.startsWith('link stalled'))
        reportLinkIssue(board.port, '板端无回包，动作已暂停，诊断日志已保存。');
      if (entry.direction === 'system' && entry.text === 'reader stopped') {
        board.activeMotion = null;
      }
    });
    if (suppressFaultAlerts) board.faultAlertsReady = true;
}

let portRefreshInFlight = false;
async function refreshPorts() {
  if (portRefreshInFlight) return;
  portRefreshInFlight = true;
  try {
    const result = await api('ports');
    const ports = result.ports.filter(port => port.esp32).sort((a, b) => {
      const af = a.port.toUpperCase() === focusedPort ? 0 : 1;
      const bf = b.port.toUpperCase() === focusedPort ? 0 : 1;
      return af - bf || a.port.localeCompare(b.port, undefined, { numeric: true });
    });
    const present = new Set(ports.map(info => info.port));
    boards.forEach(board => {
      if (!present.has(board.port)) {
        if (board.active) clearMotionTimers(board);
        board.active = false;
        board.driverReady = false;
        board.activeMotion = null;
        board.motionGeneration += 1;
        board.root.classList.add('disconnected');
        $('[data-connected]', board.root).textContent = '设备不在当前端口列表';
      }
    });
    ports.forEach(info => {
      const board = ensureBoard(info);
      if (info.active && !board.motorProfile && !board.queryingProfile) {
        board.queryingProfile = true;
        (async () => {
          await send(board.port, 'model');
          await send(board.port, 'motorprofile status');
          await send(board.port, 'cascade status');
          await send(board.port, 'knob status');
        })().catch(() => {}).finally(() => { board.queryingProfile = false; });
      }
      if (!board.events) {
        const source = new EventSource('/api/events?port=' + encodeURIComponent(board.port) + '&since=' + board.seq);
        board.events = source;
        source.onmessage = event => {
          if(board.retired)return;
          board.eventsLive = true;
          ingestLogs(board, JSON.parse(event.data));
        };
        source.onerror = () => { board.eventsLive = false; };
      }
      if (!info.active && !board.connecting && !info.maintenance) {
        board.connecting = true;
        api('connect', { port: info.port }).catch(() => {}).finally(() => { board.connecting = false; });
      }
      // null means the CDC reader has not delivered its first frame yet. It
      // is a startup state, not proof of a dead link. The old check used only
      // connected_age_ms and therefore disconnected healthy boards during
      // enumeration/stream startup.
      const noTelemetryYet = info.active && info.rx_age_ms === null &&
        info.connected_age_ms !== null && info.connected_age_ms > 5000;
      const telemetryStale = info.active && info.rx_age_ms !== null &&
        info.rx_age_ms > 2500 && !info.telemetry_ok;
      const waveStale = info.active && !info.telemetry_ok && 'sample_age_ms' in info &&
        (info.sample_age_ms === null ? info.connected_age_ms > 5000 : info.sample_age_ms > 2500);
      if ((noTelemetryYet || telemetryStale || waveStale) && !board.noTelemetryWarned) {
        board.noTelemetryWarned = true;
        board.activeMotion = null;
        reportLinkIssue(info.port,
          noTelemetryYet
            ? 'USB 端口已打开超过 5 秒，但板端没有返回任何数据。'
            : 'USB 端口仍在，但有效波形数据已超过 2.5 秒没有更新。');
      }
    });
    $('#portSummary').textContent = ports.length ?
      ports.map(port => port.port + (port.active ? (port.telemetry_ok ? ' 已连接' : ' 等待遥测') : ' 正在连接')).join(' · ') :
      '未发现 ESP32 USB 串口';
    if (!ports.length && result.usb_problems?.length) {
      $('#portSummary').textContent += ' · USB 枚举错误，请检查设备管理器；不能通过不存在的 COM 口烧录';
    }
  } catch (error) {
    $('#portSummary').textContent = '端口检测失败：' + error.message;
  } finally {
    portRefreshInFlight = false;
  }
}

function telemetryRate(board) {
  const samples = board.samples.slice(-101);
  if (samples.length < 3) return NaN;
  const duration = samples[samples.length - 1].t - samples[0].t;
  return duration > 0 ? (samples.length - 1) * 1000 / duration : NaN;
}

function updateUi(board) {
  updateKnobStatus(board);
  const sample = board.latest;
  if (!Number.isFinite(sample.t)) return;
  const set = (key, value) => {
    const element = $('[data-metric="' + key + '"]', board.root);
    if (element) element.textContent = value;
  };
  set('multi', fmt(positionValue(sample.multi), displayUnit === 'rev' ? 6 : 2) + ' ' + positionUnit());
  set('velocity', fmt(velocityValue(sample.velocity), displayUnit === 'rev' ? 4 : 1) + ' ' + velocityUnit());
  set('bus', fmt(sample.bus, 2) + ' V');
  set('current', fmt(sample.current, 3) + ' A');
  set('currentTarget', fmt(sample.currentTarget, 3) + ' A');
  set('pwm', fmt(sample.pwm, 0) + ' / 4095');
  set('fault', sample.fault ? '1 · 正常' : '0 · 故障');
  const draws = board.drawTimes;
  const fps = draws.length > 1 ? (draws.length - 1) * 1000 / (draws.at(-1) - draws[0]) : NaN;
  set('rate', fmt(telemetryRate(board), 1) + ' Hz / ' + fmt(fps, 0) + ' fps');
  Object.keys(board.canvases).forEach(key => {
    const title = $('[data-chart="' + key + '"] .chart-head span', board.root);
    if (title) title.textContent = CHARTS[key].title + '（' +
      (key === 'multi' ? positionUnit() : key === 'velocity' ? velocityUnit() : key === 'current' ? 'A' : key === 'bus' ? 'V' : '0–4095') + '）';
    const element = $('[data-chart-value="' + key + '"]', board.root);
    if (!element) return;
    if (key === 'multi') element.textContent = '实测 ' + fmt(positionValue(sample.multi), displayUnit === 'rev' ? 6 : 2) +
      ' / 目标 ' + fmt(positionValue(sample.multiTarget), displayUnit === 'rev' ? 6 : 2) + ' ' + positionUnit();
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
  const range = board.range[key];
  let min = range.min;
  let max = range.max;
  if (displayUnit === 'rev' && (key === 'multi' || key === 'velocity')) {
    min /= 360;
    max /= 360;
  }
  return [min, max];
}

function nice(value, tick = 1) {
  // Tick spacing, not the absolute angle, determines useful precision.
  const digits = clamp(Math.ceil(-Math.log10(Math.max(Math.abs(tick), 1e-7))) + 1, 0, 7);
  return fmt(value);
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
  const pad = { left: 84 * dpr, right: 14 * dpr, top: 14 * dpr, bottom: 27 * dpr };
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
    context.fillText(nice(max - (max - min) * index / 4, (max-min)/4), pad.left - 7 * dpr, y + 4 * dpr);
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

  const endTime = board.latest.t;
  context.textAlign = 'left';
  context.fillText(key === 'multi' ? positionUnit() : key === 'velocity' ? velocityUnit() :
    key === 'current' ? 'A' : key === 'bus' ? 'V' : 'PWM', pad.left + 6*dpr, pad.top + 13*dpr);
  const samples = board.samples.filter(sample => sample.t >= endTime - 10000);
  if (samples.length < 2) return;
  const scaleX = sample => pad.left + (sample.t - (endTime - 10000)) / 10000 * plotWidth;

  const stroke = (getter, color, lineWidth, alpha, smoothAlpha = 1) => {
    context.strokeStyle = color;
    context.lineWidth = lineWidth * dpr;
    context.globalAlpha = alpha;
    context.beginPath();
    let filtered = NaN;
    let began = false;
    let previousTime = NaN;
    samples.forEach((sample, index) => {
      const raw = getter(sample);
      if (!Number.isFinite(raw)) return;
      filtered = Number.isFinite(filtered) ? filtered + (raw - filtered) * smoothAlpha : raw;
      if (sample.t - previousTime > 50) { began = false; filtered = raw; }
      previousTime = sample.t;
      const x = scaleX(sample);
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

  // Smooth only the rendered polyline. Telemetry values and CSV export remain
  // raw, so this cannot hide a current spike from diagnostics.
  stroke(sample => chartValue(sample, key), CHARTS[key].color, 1.6, 1,
    CHARTS[key].smooth ?? 1);
  if (key === 'multi' || key === 'velocity' || key === 'current') {
    context.setLineDash([6 * dpr, 5 * dpr]);
    stroke(sample => targetValue(sample, key), COLORS.target, 1.4, 0.95, 1);
    context.setLineDash([]);
  }
}

const scope = {frozen:null,locked:false,ranges:{},manual:new Set(),lastDraw:0,cursor:null,offset:0,drag:null};
const scopeChannels = {
  multi:{name:'位置',unit:'r',color:'#6ed6b8',floor:.04},
  velocity:{name:'速度',unit:'r/s',color:'#e9bb72',floor:.04},
  current:{name:'电流',unit:'A',color:'#81b9ee',floor:.04},
  pwm:{name:'PWM',unit:'count',color:'#cba4df',floor:20}
};
function scopeRange(values,floor) {
  const finite=values.filter(Number.isFinite);
  if(!finite.length) return [-floor/2,floor/2];
  const lo=Math.min(...finite),hi=Math.max(...finite),span=Math.max(floor,hi-lo);
  return [(lo+hi)/2-span*.65,(lo+hi)/2+span*.65];
}
function scopeSnapshot() {
  return {end:Date.now(),series:[...boards.values()].filter(b=>b.active).map(b=>({
    port:b.port,session:b.sessionId,samples:b.samples.map(s=>({...s,multi:s.multi/360,velocity:s.velocity/360,multiTarget:s.multiTarget/360,velocityTarget:s.velocityTarget/360,wall:b.lastTelemetryAt+s.t-b.latest.t}))
  }))};
}
function scopePaneKeys(pane) {
  return [...document.querySelectorAll('#scopeChannels [data-scope-channel]:checked')].map(e=>e.dataset.scopeChannel);
}
function scopeLayout(width) {
  const count=Math.max(scopePaneKeys(0).length,scopePaneKeys(1).length,1);
  const column=72,left=12+Math.ceil(count/2)*column,right=12+Math.floor(count/2)*column;
  return {left,right,column,pw:Math.max(1,width-left-right)};
}
function scopeTickLabel(value,step) {
  if(Math.abs(value)<step*1e-7)value=0;
  return fmt(value);
}
function scopeLiveForce(){return typeof forceSession!=='undefined' && forceSession.active;}
function scopeTarget(sample,key){
  if(key==='multi')return sample.multiTarget;
  if(key==='velocity')return [2,3].includes(sample.control)?sample.velocityTarget:NaN;
  if(key==='current')return sample.control>0?sample.currentTarget:NaN;
  return NaN;
}
function drawScope(now) {
  const canvas=$('#scopeCanvas');
  if(!canvas || now-scope.lastDraw<33 || document.hidden) return;
  scope.lastDraw=now;
  $('#scopePause').disabled=scopeLiveForce();
  if(scopeLiveForce()){scope.frozen=null;scope.offset=0;$('#scopePause').textContent='力反馈实时显示';}
  else if($('#scopePause').textContent==='力反馈实时显示')$('#scopePause').textContent='暂停画面';
  const rect=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  if(rect.width<1) return;
  if(canvas.width!==Math.round(rect.width*dpr)||canvas.height!==Math.round(rect.height*dpr)) {canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);}
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);
  const width=rect.width,height=rect.height,{left,pw,column}=scopeLayout(width),lane=(height-24)/2,ph=lane-40;
  ctx.clearRect(0,0,width,height);
  const data=scope.frozen||scopeSnapshot(),windowMs=Number($('#scopeWindow').value),end=data.end-scope.offset,start=end-windowMs;
  const legends=[],readings=[];
  for(let pane=0;pane<2;pane++){
    const top=pane*lane+30,s=data.series[pane],samples=(s?.samples||[]).filter(v=>v.wall>=start&&v.wall<=end);
    const title=(pane?'下窗':'上窗')+' · '+(s?.port||'等待电机');
    const keys=scopePaneKeys(pane);
    ctx.font='12px Consolas';ctx.textAlign='left';ctx.fillStyle='#b9cbd5';ctx.fillText(title,left,top-9);
    ctx.strokeStyle='#263741';ctx.lineWidth=1;ctx.setLineDash([]);
    for(let i=0;i<=10;i++){const x=left+pw*i/10;ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,top+ph);ctx.stroke();}
    for(let i=0;i<=4;i++){const y=top+ph*i/4;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(left+pw,y);ctx.stroke();}
    const row=document.createElement('div');row.className='scope-scale-row';const label=document.createElement('b');label.textContent=s?.port||'未连接';row.append(label);
    for(const [axisIndex,key] of keys.entries()){
      const channel=scopeChannels[key],rangeKey=(s?.port||pane)+':'+key;
      if(!scope.ranges[rangeKey]||(!scope.locked&&!scope.manual.has(rangeKey)))scope.ranges[rangeKey]=scopeRange(samples.flatMap(v=>[v[key],scopeTarget(v,key)]),channel.floor);
      const [lo,hi]=scope.ranges[rangeKey];
      // Every overlaid channel owns a colored axis; units must never share
      // a misleading numeric scale. Extra channels get a second outer column.
      const onLeft=axisIndex%2===0,outer=Math.floor(axisIndex/2);
      const axisX=onLeft?left-outer*column:left+pw+outer*column;
      ctx.save();ctx.fillStyle=channel.color;ctx.strokeStyle=channel.color;
      ctx.font='11px Consolas, monospace';ctx.textAlign=onLeft?'right':'left';
      ctx.textBaseline='bottom';
      ctx.fillText(channel.name+' '+channel.unit,axisX+(onLeft?-9:9),top-9);
      ctx.textBaseline='middle';ctx.lineWidth=1;
      for(let tick=0;tick<=4;tick++){
        const y=top+ph*tick/4,value=hi-(hi-lo)*tick/4;
        ctx.fillText(scopeTickLabel(value,(hi-lo)/4),axisX+(onLeft?-9:9),y);
        ctx.beginPath();ctx.moveTo(axisX,y);ctx.lineTo(axisX+(onLeft?-5:5),y);ctx.stroke();
      }
      ctx.restore();
      const tag=document.createElement('span');tag.style.color=channel.color;tag.textContent=`${channel.name} ${fmt((hi-lo)/4)} ${channel.unit}/div · 中心 ${fmt((hi+lo)/2)}`;row.append(tag);
      ctx.save();ctx.beginPath();ctx.rect(left,top,pw,ph);ctx.clip();ctx.strokeStyle=channel.color;ctx.lineWidth=1.4;ctx.beginPath();
      let previous=null;
      for(const sample of samples){
        if(!Number.isFinite(sample[key])){previous=null;continue;}
        const x=left+(sample.wall-start)/windowMs*pw,y=top+(hi-sample[key])/(hi-lo)*ph;
        if(!previous||sample.wall-previous.wall>100)ctx.moveTo(x,y);else ctx.lineTo(x,y);previous=sample;
      }
      ctx.stroke();ctx.restore();
      ctx.save();ctx.beginPath();ctx.rect(left,top,pw,ph);ctx.clip();ctx.strokeStyle='#ff4055';ctx.lineWidth=2.4;ctx.setLineDash([9,5]);ctx.beginPath();
      previous=null;
      for(const sample of samples){
        const target=scopeTarget(sample,key);
        if(!Number.isFinite(target)){previous=null;continue;}
        const x=left+(sample.wall-start)/windowMs*pw,y=top+(hi-target)/(hi-lo)*ph;
        if(!previous||sample.wall-previous.wall>100)ctx.moveTo(x,y);else ctx.lineTo(x,y);previous=sample;
      }
      ctx.stroke();ctx.restore();
    }
    legends.push(row);
    if(!samples.length){ctx.fillStyle='#788d9b';ctx.fillText('此时间段没有数据',left+10,top+ph/2);}
    if(scope.cursor!==null){
      const f=Math.max(0,Math.min(1,(scope.cursor-left)/pw)),at=start+f*windowMs,x=left+f*pw;
      ctx.strokeStyle='#d5e1e5';ctx.setLineDash([2,4]);ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,top+ph);ctx.stroke();ctx.setLineDash([]);
      const point=samples.reduce((best,p)=>!best||Math.abs(p.wall-at)<Math.abs(best.wall-at)?p:best,null);
      readings.push((s?.port||title)+': '+(!point||Math.abs(point.wall-at)>100?'无邻近样本':keys.map(k=>scopeChannels[k].name+' '+fmt(point[k])+' '+scopeChannels[k].unit).join(' · ')));
    }
  }
  ctx.font='11px Consolas';ctx.fillStyle='#839aa9';ctx.textAlign='center';
  for(let i=0;i<=5;i++)ctx.fillText(((start+i/5*windowMs-data.end)/1000).toFixed(2)+'s',left+pw*i/5,height-5);
  $('#scopeLegend').replaceChildren(...legends);
  $('#scopeViewState').textContent=(scope.frozen?'历史定格':'实时')+' · '+(windowMs/1000).toFixed(2)+' s 窗口';
  if(readings.length&&!scopeLiveForce())$('#scopeCursor').textContent=readings.join(' ｜ ');
  else $('#scopeCursor').textContent=scopeSnapshot().series.map(s=>{
    const p=s.samples.at(-1);if(!p||Date.now()-p.wall>500)return s.port+'：数据过期';
    return s.port+': '+['multi','velocity','current','pwm'].map(k=>scopeChannels[k].name+' '+fmt(p[k])+' '+scopeChannels[k].unit).join(' · ');
  }).join(' ｜ ');
}
function scopeFreeze(){if(!scope.frozen)scope.frozen=scopeSnapshot();$('#scopePause').textContent='回到实时';$('#scopePause').setAttribute('aria-pressed','true');}
function scopeOffset(value){
  const data=scope.frozen||scopeSnapshot();
  const first=Math.min(data.end,...data.series.flatMap(s=>s.samples.slice(0,1).map(p=>p.wall)));
  scope.offset=Math.max(0,Math.min(Math.max(0,data.end-first-Number($('#scopeWindow').value)),value));
}
function scopeZoom(factor,anchor=.5){
  if(!scopeLiveForce())scopeFreeze();const old=Number($('#scopeWindow').value),next=Math.max(100,Math.min(10000,Math.round(old*factor)));
  const select=$('#scopeWindow');let custom=select.querySelector('[data-custom]');if(custom)custom.remove();
  if(![...select.options].some(o=>Number(o.value)===next)){custom=new Option((next/1000).toFixed(2)+' s',String(next));custom.dataset.custom='1';select.add(custom);}
  select.value=String(next);scopeOffset(scope.offset+(old-next)*(1-anchor));
}
function scopeZoomY(factor,pane=Number($('#scopePane').value)){
  const data=scope.frozen||scopeSnapshot(),s=data.series[pane];if(!s)return;
  const key=$('#scopeYChannel').value,rangeKey=s.port+':'+key;
  const [lo,hi]=scope.ranges[rangeKey]||scopeRange(s.samples.map(p=>p[key]),scopeChannels[key].floor);
  const center=(lo+hi)/2,span=Math.max(1e-6,Math.min(1e10,(hi-lo)*factor));
  scope.ranges[rangeKey]=[center-span/2,center+span/2];scope.manual.add(rangeKey);
}
function scopeReset(){scope.frozen=null;scope.offset=0;scope.locked=false;scope.ranges={};scope.manual.clear();$('#scopeWindow').value='5000';$('#scopePause').textContent='暂停画面';$('#scopePause').setAttribute('aria-pressed','false');$('#scopeScale').textContent='锁定量程';$('#scopeScale').setAttribute('aria-pressed','false');}
$('#scopePause').addEventListener('click',()=>{
  if(scope.frozen){scope.frozen=null;scope.offset=0;$('#scopePause').textContent='暂停画面';$('#scopePause').setAttribute('aria-pressed','false');}else scopeFreeze();
});
$('#scopeScale').addEventListener('click',()=>{
  scope.locked=!scope.locked;if(!scope.locked)scope.manual.clear();$('#scopeScale').textContent=scope.locked?'恢复自动量程':'锁定量程';$('#scopeScale').setAttribute('aria-pressed',String(scope.locked));
});
$('#scopeZoomIn').addEventListener('click',()=>scopeZoom(.5));$('#scopeZoomOut').addEventListener('click',()=>scopeZoom(2));
$('#scopeYIn').addEventListener('click',()=>scopeZoomY(.5));$('#scopeYOut').addEventListener('click',()=>scopeZoomY(2));
$('#scopeReset').addEventListener('click',scopeReset);$('#scopeCanvas').addEventListener('dblclick',scopeReset);
$('#scopeWindow').addEventListener('change',()=>scopeOffset(scope.offset));
$('#scopeCanvas').addEventListener('wheel',e=>{
  e.preventDefault();const r=e.currentTarget.getBoundingClientRect(),pane=e.clientY-r.top<r.height/2?0:1;
  $('#scopePane').value=String(pane);
  const layout=scopeLayout(r.width);
  if(e.shiftKey)scopeZoomY(e.deltaY<0?.8:1.25,pane);else scopeZoom(e.deltaY<0?.8:1.25,Math.max(0,Math.min(1,(e.clientX-r.left-layout.left)/layout.pw)));
},{passive:false});
$('#scopeCanvas').addEventListener('pointerdown',e=>{if(e.button!==0)return;scope.drag={x:e.clientX,offset:scope.offset};e.currentTarget.setPointerCapture(e.pointerId);});
$('#scopeCanvas').addEventListener('pointermove',e=>{
  const r=e.currentTarget.getBoundingClientRect();scope.cursor=e.clientX-r.left;
  if(scope.drag&&Math.abs(e.clientX-scope.drag.x)>3){scopeFreeze();scopeOffset(scope.drag.offset+(e.clientX-scope.drag.x)/scopeLayout(r.width).pw*Number($('#scopeWindow').value));}
});
for(const event of ['pointerup','pointercancel','lostpointercapture'])$('#scopeCanvas').addEventListener(event,()=>{scope.drag=null;});
$('#scopeCanvas').addEventListener('pointerleave',()=>{if(!scope.drag)scope.cursor=null;});
function animationFrame(now) {
  drawScope(now);
  boards.forEach(board => {
    if (now - board.lastUiAt >= 100) {
      updateUi(board);
      board.lastUiAt = now;
    }
    if (board.dirty && !document.hidden) {
      Object.entries(board.canvases).forEach(([key, canvas]) => drawChart(board, key, canvas));
      board.lastDrawAt = now;
      board.drawTimes.push(now);
      while (board.drawTimes.length > 2 && now - board.drawTimes[0] > 1000) board.drawTimes.shift();
      board.dirty = false;
    }
  });
  requestAnimationFrame(animationFrame);
}

// Quick controls share the existing motion transport and firmware leases.
const quickModes = {
  position:{label:'位置',unit:'r',scale:360,range:10,color:'#6ed6b8'},
  velocity:{label:'速度',unit:'r/s',scale:360,range:15,color:'#e9bb72'},
  current:{label:'电流',unit:'A',scale:1000,range:1,color:'#81b9ee'}
};
let quickRun=null, quickBusy=false, quickEpoch=0, quickPending=null, quickTimer=null;
function quickSchedule(mode) {
  quickPending=mode;
  if(quickBusy || quickTimer!==null)return;
  quickTimer=setTimeout(()=>{
    quickTimer=null;const next=quickPending;quickPending=null;
    if(next)quickApply(next,quickRun?.mode!==next);
  },40);
}
function quickCancelPending() {
  clearTimeout(quickTimer);quickTimer=null;quickPending=null;
}
for (const [mode,c] of Object.entries(quickModes)) {
  const row=document.createElement('div');row.className='quick-row';row.style.setProperty('--signal',c.color);
  row.innerHTML=`<label for="quick-${mode}">${c.label}<small>±${fmt(c.range)} ${c.unit}</small></label><input id="quick-${mode}" type="range" min="-${c.range}" max="${c.range}" step="any" value="0"><output for="quick-${mode}">0.00 ${c.unit}</output>`;
  $('#quickRows').append(row);
  const input=$('input',row),output=$('output',row);
  input.addEventListener('input',()=>{output.textContent=fmt(Number(input.value))+' '+c.unit;quickSchedule(mode);});
  input.addEventListener('pointerdown',()=>quickSchedule(mode));
  input.addEventListener('change',()=>quickSchedule(mode));
}
function quickTargets() {
  const active=[...boards.values()].filter(b=>b.active),selection=$('#quickBoard').value;
  const targets=selection==='both'?active.slice(0,2):[active[Number(selection)]];
  if(targets.some(b=>!b) || targets.length!==(selection==='both'?2:1))throw new Error('所选电机未连接；请先连接设备');
  return targets;
}
async function quickStop(preservePending=false) {
  if(!preservePending)quickCancelPending();
  quickEpoch++;
  const previous=quickRun;quickRun=null;
  if(previous) await Promise.all(previous.targets.map(async b=>{
    clearMotionTimers(b);b.motionGeneration++;b.activeMotion=null;
    await send(b.port,'stop');
  }));
}
async function quickApply(mode,start) {
  if(quickBusy)return;
  quickBusy=true;let targets=[],started=false;
  try {
    targets=quickTargets();
    if(forceSession.active || $('#forceStart').disabled)throw new Error('请先停止力反馈或辨识，再进行手动测试');
    const value=Number($('#quick-'+mode).value)*quickModes[mode].scale;
    if(!Number.isFinite(value))throw new Error('目标值无效');
    for(const b of targets) {
      if(!b.latest || Date.now()-b.lastTelemetryAt>500)throw new Error(b.port+' 遥测过期，请重新连接');
      if(mode==='current' && (!Number.isFinite(b.motorSettings?.current) || b.motorSettings.current<=0))throw new Error(b.port+' 尚未回读有效电流上限');
      if(mode==='velocity' && Math.abs(value)>b.targetLimits.velocityTarget)throw new Error(b.port+' 速度目标超过当前电机配置范围');
    }
    if(start) {
      const stopping=quickStop(true),epoch=quickEpoch;
      await stopping;
      if(epoch!==quickEpoch)throw new Error('测试已取消');
      quickRun={mode,targets,centers:targets.map(b=>b.latest.multi),generations:targets.map(b=>b.motionGeneration),sessions:targets.map(b=>b.sessionId)};
    }
    const run=quickRun;
    if(!run || run.mode!==mode || targets.some((b,i)=>b!==run.targets[i] || b.sessionId!==run.sessions[i] || b.motionGeneration!==run.generations[i] || (!start && b.activeMotion?.mode!==mode)))throw new Error('测试已停止或连接已变化，请点击执行重新开始');
    started=true;
    for(let i=0;i<targets.length;i++) {
      if(quickRun!==run)throw new Error('测试已取消');
      const target=mode==='current'?Math.max(-targets[i].motorSettings.current*800,Math.min(targets[i].motorSettings.current*800,value)):value;
      if(mode==='position' && Math.abs(target)>targets[i].targetLimits.positionTarget)throw new Error('位置目标超出有效范围，请减小偏移');
      await runMotion(targets[i],mode,target,run.generations[i]);
    }
    document.querySelectorAll('.quick-row').forEach(row=>row.classList.toggle('controlling',!!row.querySelector('#quick-'+mode)));
    $('#quickState').textContent=targets.map(b=>b.port).join(' + ')+' · 正在控制'+quickModes[mode].label+' · '+fmt(value/quickModes[mode].scale)+' '+quickModes[mode].unit+(mode==='current'&&targets.some(b=>Math.abs(value)>b.motorSettings.current*800)?'（已限幅至各板最大电流的 80%）':'');
  } catch(error) {
    const stopped=await Promise.allSettled((started?targets:quickRun?.targets||[]).map(async b=>{clearMotionTimers(b);b.motionGeneration++;b.activeMotion=null;await send(b.port,'stop');}));
    quickCancelPending();quickRun=null;$('#quickState').textContent=error.message+(stopped.some(r=>r.status==='rejected')?'；停止指令未全部确认，请检查连接':'');
  } finally {quickBusy=false;if(quickPending)quickSchedule(quickPending);}
}
$('#quickStop').addEventListener('click',()=>quickStop().then(()=>{$('#quickState').textContent='测试已停止';}).catch(e=>{$('#quickState').textContent='停止未确认：'+e.message;}));
$('#quickBoard').addEventListener('change',()=>quickStop().then(()=>{$('#quickState').textContent='控制对象已切换；点击执行开始新测试';}).catch(e=>{$('#quickState').textContent=e.message;}));
$('#stopAll').addEventListener('click',()=>{quickCancelPending();quickEpoch++;quickRun=null;});
document.addEventListener('visibilitychange',()=>{if(document.hidden){quickCancelPending();quickEpoch++;quickRun=null;}});

$('#unit').addEventListener('change', event => {
  displayUnit = event.target.value;
  boards.forEach(board => {
    board.root.querySelectorAll('[data-slider]').forEach(input => updateSliderOutput(board, input));
    refreshWindowLabels(board);
    drawKnobPreview(board);
    board.dirty = true;
  });
  const value = Number($('#fleetTarget').value);
  $('#fleetTargetOut').textContent = fmt(positionValue(value), displayUnit === 'rev' ? 3 : 0) + ' ' + positionUnit();
});

$('#fleetTarget').addEventListener('input', event => {
  const value = Number(event.target.value);
  $('#fleetTargetOut').textContent = fmt(positionValue(value), displayUnit === 'rev' ? 3 : 0) + ' ' + positionUnit();
});

async function connectOrRecover(port) {
  const state=(await api('ports')).ports.find(p=>p.port===port);
  if(!state?.present)throw new Error(port+' 未被系统识别，请检查 USB');
  const stale=state.active && (!state.write_ok || state.last_error || (state.connected_age_ms>5000 && !state.telemetry_ok));
  return api(stale?'recover-link':'connect',{port});
}
$('#connectAll').addEventListener('click', () => {
  Promise.allSettled([...boards.values()].map(board => connectOrRecover(board.port))).then(results=>{
    const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason.message);
    if(errors.length)toast(errors.join('；'),true);
  });
});

$('#stopAll').addEventListener('click', () => {
  Promise.all([...boards.values()].filter(board => board.active).map(stopAndPrepare)).catch(() => {});
});

$('#motorSettingsOpen').addEventListener('click', () => {
  const values=[...boards.values()].filter(b=>b.active).map(b=>b.motorSettings);
  if(values.length===2 && values.every(v=>v && ['voltage','current','gear'].every(k=>Number.isFinite(v[k]) && v[k]===values[0][k]))) {
    $('#motorVoltage').value=values[0].voltage;
    $('#motorMaxCurrent').value=values[0].current;
    $('#motorGear').value=values[0].gear;
  }
  $('#motorSettingsWindow').show();
});
$('#motorSettingsClose').addEventListener('click', () => { $('#motorSettingsWindow').close(); $('#motorSettingsOpen').focus(); });
{
  const panel=$('#motorSettingsWindow'), bar=$('.settings-window-bar');
  let drag=null;
  bar.addEventListener('pointerdown', e=>{
    if(e.target.closest('button')) return;
    const r=panel.getBoundingClientRect(); drag={x:e.clientX-r.left,y:e.clientY-r.top};bar.setPointerCapture(e.pointerId);
  });
  bar.addEventListener('pointermove', e=>{
    if(!drag)return;
    panel.style.right='auto';
    panel.style.left=Math.max(0,Math.min(innerWidth-panel.offsetWidth,e.clientX-drag.x))+'px';
    panel.style.top=Math.max(0,Math.min(innerHeight-60,e.clientY-drag.y))+'px';
  });
  bar.addEventListener('pointerup',()=>drag=null);bar.addEventListener('pointercancel',()=>drag=null);
}
$('#motorSettings').addEventListener('submit', event => {
  event.preventDefault();
  forceLocked(async () => {
    if (autoTune.active) throw new Error('辨识正在运行，请先停止');
    const pair = [...boards.values()].filter(b=>b.active);
    if (pair.length !== 2 || pair.some(b=>b.motorProfile !== '36gp555')) throw new Error('请连接两块 36GP 板');
    const voltage = Number($('#motorVoltage').value), current = Number($('#motorMaxCurrent').value), gear = Number($('#motorGear').value);
    if (![voltage,current,gear].every(Number.isFinite) || voltage < 3 || voltage > 24 || current < .1 || current > 2 || gear < 1 || gear > 1000) throw new Error('电压 3–24 V，电流 0.1–2 A，减速比 1–1000');
    const state = $('#motorSettingsState');
    state.dataset.busy = '1';
    const applied = [];
    try {
      state.textContent = '正在停止两板并核对固件…';
      await cleanupForcePair(pair);
      for (const b of pair) await send(b.port, 'sleep');
      // Preflight BOTH boards before writing either. Old firmware must never
      // produce a cosmetic "saved" result in the browser.
      for (const b of pair) {
        const reply = (await send(b.port, 'model')).reply;
        if (!/fw=0\.5\.[678]-/.test(reply)) throw new Error(b.port + ' 需要升级固件，设置尚未写入');
      }
      for (const b of pair) {
        await send(b.port, `motorset ${voltage} ${current} ${gear}`);
        applied.push(b.port);
        const reply = (await send(b.port, 'motorprofile status')).reply;
        parseLine(b, reply);
        const actual = b.motorSettings;
        if (!actual || Math.abs(actual.voltage-voltage)>.011 || Math.abs(actual.current-current)>.011 || Math.abs(actual.gear-gear)>.011) throw new Error(b.port+' 设置回读不一致');
        b.modelKe = null; b.configApplied = false; b.appliedCommands = {};
        b.samples = []; b.configDirty = false;
      }
      state.textContent = `两板已确认：${voltage} V / ${current} A / ${gear}:1。保持停止；原辨识结果失效，需要重新辨识。`;
    } catch (error) {
      state.textContent = error.message + (applied.length ? '；已写入 '+applied.join('、')+'，请核对两板再重试。' : '；未写入电机设置。');
    } finally { delete state.dataset.busy; }
  }).catch(error=> { $('#motorSettingsState').textContent = error.message; });
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
  $('#forceKOut').textContent = fmt(Number($('#forceK').value)) + ' mA/°';
  $('#forceDOut').textContent = Number($('#forceD').value).toFixed(2) + ' mA/(°/s)';
  $('#forceLimitOut').textContent = fmt(Number($('#forceLimit').value)) + ' mA';
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await pause(40);
  }
  throw new Error(message);
}

async function sendBusPing(board, peer) {
  const startedAt = Date.now();
  board.lastBusPong = null;
  await send(board.port, 'bus ' + peer.busAddress + ' ping');
  await waitUntil(() => board.lastBusPong && board.lastBusPong.at >= startedAt &&
    board.lastBusPong.source === peer.busAddress,
    1500, board.port + ' 未收到 DATA 总线 PONG');
}

async function forcePair() {
  const pair = [...boards.values()].filter(board => board.active);
  if (pair.length !== 2) throw new Error('需要恰好两块在线板');
  if (pair.some(board => Date.now() - board.lastTelemetryAt > 500 || !board.sessionId)) throw new Error('两板遥测必须新鲜，请等待通信恢复');
  if (pair.some(board => !Number.isFinite(board.latest.bus) || board.latest.bus < 8 || board.latest.bus > 50)) {
    throw new Error('两块板母线必须在 8–50 V，未执行力反馈');
  }
  if (pair.some(board => board.latest.fault !== 1)) {
    throw new Error('检测到 nFAULT 异常，未执行力反馈');
  }
  await Promise.all(pair.map(board => send(board.port, 'businfo')));
  await waitUntil(() => pair.every(board => Number.isInteger(board.busAddress)),
    1200, '未读到两块板的 DATA 地址');
  if (pair[0].busAddress === pair[1].busAddress) {
    throw new Error('两块板 DATA 地址重复');
  }
  // Verify the physical DATA path in both directions before enabling torque.
  await sendBusPing(pair[0], pair[1]);
  await sendBusPing(pair[1], pair[0]);
  return pair;
}

async function cleanupForcePair(pair) {
  const stopped = await Promise.all(pair.map(async board => {
    const stop = await send(board.port, 'stop').then(() => true, () => false);
    const disarm = await send(board.port, 'sync stop').then(() => true, () => false);
    await send(board.port, 'stream 100').catch(() => {});
    return {board, confirmed: stop && disarm};
  }));
  forceSession.active = false;
  forceSession.boards = stopped.filter(item => !item.confirmed).map(item => item.board);
  if (forceSession.boards.length) throw new Error('停机回执未确认：' + forceSession.boards.map(board => board.port).join('、') + '，请检查设备；不能确认输出已归零');
}

async function startForceFeedback() {
  if (autoTune.active) throw new Error('请等待自动整定结束，或先停止');
  const token = ++forceSession.token;
  const check = () => { if (token !== forceSession.token) throw new Error('力反馈启动已取消'); };
  return forceLocked(async () => {
    check();
    const startButton = $('#forceStart');
    startButton.disabled = true;
    forceState('正在核对母线、nFAULT 和 DATA 双向 PING…');
    let pair = [];
    try {
      pair = await forcePair();
      check();
      for (const board of pair) {
        const reply = (await send(board.port, 'model')).reply;
        if (!/fw=0\.5\.(8-coast-autotune|9-sync-trace)/.test(reply)) throw new Error(board.port + ' 需要升级滑行停止修正固件；未启动');
      }
      pair.forEach(board => { clearMotionTimers(board); board.activeMotion = null; board.motionGeneration += 1; });
      // Reduce USB telemetry while force mode is active. DATA synchronization
      // remains at 200 Hz. Reduced USB load is not a timing guarantee.
      await Promise.all(pair.map(async board => {
        await send(board.port, 'stop');
        await send(board.port, 'stream 50');
        check();
        await ensureReady(board);
      }));
      check();
      const stiffness = Number($('#forceK').value);
      const damping = Number($('#forceD').value);
      const limit = Math.min(Number($('#forceLimit').value), ...pair.map(b=>(b.motorSettings?.current ?? NaN)*800));
      if (![stiffness, damping, limit].every(Number.isFinite) || limit < 200 || limit > 2000) {
        throw new Error('成人力反馈参数超出 0.2–2.0 A 调试范围');
      }
      // Configure the higher address first; it only responds. The lower
      // address becomes the 200 Hz synchronization requester last.
      const ordered = [...pair].sort((a, b) => b.busAddress - a.busAddress);
      const weakestKt = Math.min(...pair.map(board => board.modelKe));
      if (!Number.isFinite(weakestKt) || weakestKt <= 0) throw new Error('缺少电机扭矩模型');
      if (Math.abs(pair[0].latest.multi-pair[1].latest.multi)*gearOf(pair[0])>360) {
        forceState('初始坐标差较大，正在停止并建立本次相对零位…');
        await rebaseForcePair(pair);
        check();
      }
      const origins = new Map(pair.map(board => [board.port, board.latest.multi]));
      for (const board of ordered) {
        check();
        const peer = pair.find(item => item !== board);
        if (gearOf(board) !== gearOf(peer)) throw new Error('两块板减速比不一致');
        const offset = (origins.get(board.port) - origins.get(peer.port)) * gearOf(board);
        const torqueScale = weakestKt / board.modelKe;
        if (!Number.isFinite(offset) || Math.abs(offset) > 360) throw new Error('两轴初始角度差超出支持范围，请停机后清零');
        await send(board.port, 'sync force ' + peer.busAddress + ' ' +
          serialNumber(stiffness * torqueScale / gearOf(board)) + ' ' +
          serialNumber(damping * torqueScale / gearOf(board)) + ' 0 ' + serialNumber(limit * torqueScale) + ' 4095 30000 ' + serialNumber(offset));
        await pause(80);
      }
      const replies = await Promise.all(pair.map(board => send(board.port, 'sync status')));
      check();
      if (!replies.every(result => result.reply?.includes('mode=force') && result.reply?.includes('armed=1'))) {
        throw new Error('双板力反馈未同时 armed=1');
      }
      forceSession.active = true;
      scopeReset();
      forceSession.boards = pair;
      forceSession.startedAt = Date.now();
      forceSession.timer = setTimeout(() => stopForceFeedback().catch(() => {}), 60000);
      forceState('双向力反馈已启用 · DATA 目标 200 Hz · ' + limit.toFixed(0) + ' mA 上限', 'good');
    } catch (error) {
      await cleanupForcePair(pair);
      throw error;
    } finally {
      startButton.disabled = false;
    }
  });
}

async function stopForceFeedback() {
  ++forceSession.token;
  clearTimeout(forceSession.timer);
  forceSession.active = false;
    const pair = forceSession.boards.length
      ? forceSession.boards
      : [...boards.values()].filter(board => board.active);
    await cleanupForcePair(pair);
    forceState('力反馈已停止 · 双板停止指令已确认');
}

async function rebaseForcePair(pair) {
  if(autoTune.active) throw new Error('请先停止自动整定');
  if(pair.length!==2) throw new Error('需要两台在线设备');
  await cleanupForcePair(pair);
  for(const b of pair) {
    if(Date.now()-b.lastTelemetryAt>500 || b.latest.fault!==1) throw new Error(b.port+' 遥测异常，未清零');
    const started=Date.now();
    await send(b.port,'encreset');
    await waitUntil(()=>b.lastTelemetryAt>=started && Math.abs(b.latest.multi)<.05,1500,b.port+' 相对零位未确认，请保持手柄静止后重试');
    setSlider(b,'positionTarget',b.latest.multi);
    resetChartRanges(b,b.latest);
  }
}
$('#forceRebase').addEventListener('click',async()=>{
  $('#forceRebase').disabled=true;
  try { await stopForceFeedback(); await rebaseForcePair([...boards.values()].filter(b=>b.active)); forceState('起点已对齐，电机保持停止。点击启动力反馈开始。'); }
  catch(e) { forceState(e.message,'bad'); }
  finally { $('#forceRebase').disabled=false; }
});

['forceK', 'forceD', 'forceLimit'].forEach(id => $('#' + id).addEventListener('input', updateForceOutputs));
$('#forceStart').addEventListener('click', () => startForceFeedback().catch(error => {
  forceState('力反馈启动失败：' + error.message, 'bad');
  toast('力反馈启动失败：' + error.message, true);
}));
$('#forceStop').addEventListener('click', () => stopForceFeedback().catch(error => toast(error.message, true)));
updateForceOutputs();

// Bounded empirical tuning. A result is valid only for the tested load/range.
function positionTrialMetrics(samples, origin, target) {
  if (samples.length < 60 || samples.at(-1).t - samples[0].t < 1000) throw new Error('有效遥测不足，不能评价整定');
  const sign = Math.sign(target-origin);
  const overshoot = Math.max(0,...samples.map(s => sign*(s.multi-target)));
  const tail = samples.filter(s => s.t >= samples.at(-1).t-300);
  const error = Math.max(...tail.map(s => Math.abs(s.multi-target)));
  let settlingMs = Infinity;
  for (let i=0;i<samples.length;i++) {
    if (samples.at(-1).t-samples[i].t<300) break;
    if (samples.slice(i).every(s=>Math.abs(s.multi-target)<=.1)) { settlingMs=samples[i].t-samples[0].t; break; }
  }
  return {overshoot,error,settlingMs,passed:overshoot<=.1 && error<=.1 && Number.isFinite(settlingMs)};
}

function currentTraceMetrics(trace, target) {
  if(!Array.isArray(trace)||trace.length<100||!Number.isFinite(target)||Math.abs(target)<.01)
    throw new Error('电流复测高速记录不足');
  if(trace.some((r,i)=>!r.slice(0,4).every(Number.isFinite)||(i&&r[0]<=trace[i-1][0])))
    throw new Error('电流复测时间戳或数值无效');
  const end=trace.at(-1)[0],tail=trace.filter(r=>r[0]>=end-60000);
  if(end-trace[0][0]<120000||tail.length<60||tail.at(-1)[0]-tail[0][0]<50000)
    throw new Error('电流复测有效时间不足');
  const mean=tail.reduce((sum,r)=>sum+r[2],0)/tail.length;
  const rms=Math.sqrt(tail.reduce((sum,r)=>sum+(r[2]-target)**2,0)/tail.length);
  const rippleRms=Math.sqrt(tail.reduce((sum,r)=>sum+(r[2]-mean)**2,0)/tail.length);
  const peak=Math.max(...trace.map(r=>Math.abs(r[2])));
  const referencesValid=tail.every(r=>Math.abs(r[1]-target)<=.01);
  const maxGapUs=Math.max(...trace.slice(1).map((r,i)=>r[0]-trace[i][0]));
  return {mean,rms,rippleRms,peak,maxGapUs,samples:trace.length,tailSamples:tail.length,
    scope:'180 ms 短脉冲末段 60 ms；反馈滤波后电流，非 PWM 载波纹波或连续负载验收',
    passed:referencesValid&&maxGapUs<=3000&&Math.abs(mean-target)<=.04&&rms<=.04&&peak<=Math.abs(target)*1.3+.04};
}

function fitControlRows(rows, label) {
  if(rows.length<16 || rows.some(r=>![...r.x,r.y].every(Number.isFinite))) throw new Error(label+'：有效样本不足');
  const grouped=rows.every(r=>Number.isInteger(r.group));
  const groups=grouped?[...new Set(rows.map(r=>r.group))].sort((a,b)=>a-b):[];
  // With short-pulse campaigns, reserve two whole pulses, never randomly
  // interleave neighbouring samples from a single response across the split.
  const heldOut=new Set(groups.slice(groups.length>=6?-2:-1));
  const train=rows.filter((r,i)=>grouped?!heldOut.has(r.group):i%4!==0),test=rows.filter((r,i)=>grouped?heldOut.has(r.group):i%4===0),n=rows[0].x.length;
  if(train.length<8||test.length<4)throw new Error(label+'：独立验证样本不足');
  const scales=Array.from({length:n},(_,i)=>Math.sqrt(train.reduce((s,r)=>s+r.x[i]**2,0)/train.length));
  if(scales.some(v=>v<1e-9))throw new Error(label+'：激励不足');
  const a=Array.from({length:n},(_,i)=>[...Array.from({length:n},(_,j)=>train.reduce((s,r)=>s+r.x[i]*r.x[j]/scales[i]/scales[j],0)),train.reduce((s,r)=>s+r.x[i]*r.y/scales[i],0)]);
  for(let i=0;i<n;i++){
    let p=i;for(let j=i+1;j<n;j++)if(Math.abs(a[j][i])>Math.abs(a[p][i]))p=j;
    [a[i],a[p]]=[a[p],a[i]];
    if(Math.abs(a[i][i])<1e-5)throw new Error(label+'：模型不可辨识，未写入参数');
    const d=a[i][i];a[i]=a[i].map(v=>v/d);
    for(let j=0;j<n;j++)if(i!==j){const f=a[j][i];a[j]=a[j].map((v,k)=>v-f*a[i][k]);}
  }
  const coefficients=a.map((r,i)=>r[n]/scales[i]);
  const mse=test.reduce((s,r)=>s+(r.y-r.x.reduce((v,x,i)=>v+x*coefficients[i],0))**2,0)/test.length;
  const energy=test.reduce((s,r)=>s+r.y**2,0)/test.length;
  const relativeError=Math.sqrt(mse/Math.max(energy,1e-12));
  if(!Number.isFinite(relativeError)||relativeError>.25)throw new Error(label+'：留出样本相对误差 '+(relativeError*100).toFixed(1)+'%，超过 25%，保留原参数');
  return {coefficients,relativeError,samples:rows.length,trainingSamples:train.length,validationSamples:test.length,heldOutGroups:[...heldOut]};
}

function movingElectricalRows(pulses, gear) {
  // Integrate V = R*i + L*di/dt + Ke*omega + brush drop.
  // Both clocks are board clocks (us / ms), never host arrival times.
  // Interpolate only within telemetry brackets; do not extrapolate motion.
  const rows=[];
  for(const [group,pulse] of pulses.entries()) {
    const samples=pulse.samples,trace=pulse.trace;
    if(samples.some((s,i)=>!Number.isFinite(s.t)||!Number.isFinite(s.velocity)||(i&&s.t<=samples[i-1].t)))throw new Error('电气模型：速度时间戳无效');
    const omega=us=>{
      const ms=us/1000;
      const k=samples.findIndex((s,i)=>i&&s.t>=ms&&samples[i-1].t<=ms);
      if(k<1||samples[k].t-samples[k-1].t>25)return null;
      const a=samples[k-1],b=samples[k],f=(ms-a.t)/(b.t-a.t);
      return (a.velocity+(b.velocity-a.velocity)*f)*gear*Math.PI/180;
    };
    for(let j=8;j<trace.length;j+=8) {
      const p=trace[j-8],q=trace[j],dt=(q[0]-p[0])/1e6;
      if(dt<=0||dt>.015)continue;
      let current=0,voltage=0,speed=0,valid=true;
      for(let k=j-8;k<j;k++) {
        const a=trace[k],b=trace[k+1],step=(b[0]-a[0])/1e6;
        const synchronous=a.length>=8&&b.length>=8;
        const fresh=synchronous&&a[6]>=0&&b[6]>=0&&a[6]<=3000&&b[6]<=3000;
        const w=synchronous?(fresh?(a[5]+b[5])*.5*Math.PI/180:null):omega((a[0]+b[0])/2);
        if(w===null||step<=0||step>.003){valid=false;break;}
        current+=(a[2]+b[2])*.5*step;
        voltage+=b[3]*(synchronous?b[7]:pulse.bus)/4095*step;
        speed+=w*step;
      }
      if(valid)rows.push({group,x:[current/dt,(q[2]-p[2])/dt,Math.sign(pulse.ma),speed/dt],y:voltage/dt});
    }
  }
  return rows;
}

function electricalControllerFromFit(e, bus, moving=true) {
  const [R,L,drop,Ke]=e.coefficients;
  if(!Number.isFinite(bus)||bus<8||bus>50||!(R>.05&&R<20&&L>1e-6&&L<.1&&drop>=-.05)||
     (moving&&!(Ke>0&&Ke<1)))throw new Error('电气模型：辨识系数不符合物理范围，未采用参数');
  const wc=Math.min(2*Math.PI*60,.2*R/L);
  const currentKp=L*wc*4095/bus,currentKi=R*wc*4095/bus;
  if(currentKp>5000||currentKi>2000000)throw new Error('计算电流增益超出固件范围');
  return {R,effectiveL:L,voltageDrop:drop,Ke:moving?Ke:null,electricalMethod:moving?'moving-integral':'near-stationary',electrical:e,currentBandwidth:wc,currentKp,currentKi};
}

function calculateThreeLoopModel(pulses, gear, bus) {
  if(pulses.length<4||!Number.isFinite(gear)||gear<1||!Number.isFinite(bus)||bus<8||pulses.some(p=>!p.samples.length||p.trace.length<100))throw new Error('模型辨识记录不完整');
  const electrical=[],mechanical=[];
  for(const [group,pulse] of pulses.entries()) {
    const trace=pulse.trace;
    let samples=pulse.samples;
    if(trace.every(r=>r.length>=8)) {
      samples=[];
      for(const r of trace) {
        if(r[6]>3000||r[6]<0)continue;
        if(!samples.length||r[0]/1000-samples.at(-1).t>=10)
          samples.push({t:r[0]/1000,current:r[2],velocity:r[5]/gear,multi:r[4]/gear});
      }
    }
    // Only the initial near-stationary interval is used for the electrical
    // model. Filter/bridge delay is included in effective L, not called a
    // certified winding-inductance measurement.
    const early=samples.filter(s=>s.t-samples[0].t<40);
    if(early.length && early.every(s=>Math.abs(s.velocity)<5)) {
      for(let j=4;j<trace.length;j+=4) {
        const p=trace[j-4],q=trace[j],dt=(q[0]-p[0])/1e6;
        if(q[0]-trace[0][0]>40000)break;
        if(dt<=0||dt>.005)continue;
        const chunk=trace.slice(j-4,j),mean=k=>chunk.reduce((s,r)=>s+r[k],0)/chunk.length;
        electrical.push({group,x:[mean(2),(q[2]-p[2])/dt,Math.sign(pulse.ma)],y:mean(3)*pulse.bus/4095});
      }
    }
    // Twenty-millisecond windows retain useful moving portions of bounded
    // short pulses. Keep zero-speed/reversal exclusion and held-out validation.
    for(let j=2;j<samples.length;j+=2) {
      const p=samples[j-2],q=samples[j],dt=(q.t-p.t)/1000,chunk=samples.slice(j-2,j+1);
      if(dt<=0||dt>.07||chunk.some(s=>Math.abs(s.velocity)<2||Math.sign(s.velocity)!==Math.sign(q.velocity)))continue;
      const avg=k=>chunk.reduce((s,r)=>s+r[k],0)/chunk.length;
      mechanical.push({group,x:[avg('current'),-avg('velocity')*gear,-Math.sign(q.velocity)],y:(q.velocity-p.velocity)*gear/dt});
    }
  }
  const moving=pulses.every(p=>p.trace.every(r=>r.length>=8))||electrical.length<16;
  const e=fitControlRows(moving?movingElectricalRows(pulses,gear):electrical,'电气模型');
  const electricalModel=electricalControllerFromFit(e,bus,moving);
  const m=fitControlRows(mechanical,'机械模型');
  const [a,b,friction]=m.coefficients;
  if(!(a>10&&a<1e7&&b>=0&&friction>=0))throw new Error('辨识系数不满足物理范围；没有采用参数');
  const wv=Math.min(electricalModel.currentBandwidth/10,12);
  if(wv<1||2*1.2*wv<=b)throw new Error('模型不支持当前三环带宽分离，保留原参数');
  return {...electricalModel,accelPerA:a,viscous:b,friction,
    mechanical:m,velocityBandwidth:wv,
    candidates:[.5,.75,1].map(scale=>{const w=wv*scale;return {positionKp:w/5,positionKd:0,velocityKp:(2*1.2*w-b)/a,velocityKi:w*w/a};}).filter(c=>c.velocityKp>0)};
}

async function runAutoTune(identificationOnly = false) {
  if (autoTune.active) return;
  await stopForceFeedback();
  const pair=[...boards.values()].filter(b=>b.active);
  if (pair.length!==2 || pair.some(b=>b.motorProfile!=='36gp555')) throw new Error('请先连接两台 36GP-555');
  autoTune.active=true; autoTune.cancelled=false; autoTune.reports=[];
  document.body.classList.add('tuning'); $('#autoTune').disabled=true;
  $('#identifyCapture').disabled=true;
  const tx=(b,c)=>send(b.port,c,autoTune);
  const check=b=>{
    if(autoTune.cancelled) throw new Error('已取消整定');
    if(!b.active || Date.now()-b.lastTelemetryAt>250 || b.latest.fault!==1 || b.latest.bus<8 || b.latest.bus>50) throw new Error(b.port+' 遥测或电源异常，已中止整定');
  };
  const capture=async(b,command,duration,expectedControl,stopAfter=true)=>{
    check(b); const epoch=b.sessionId, origin=b.latest.multi, t=b.latest.t;
    await tx(b,command);
    const until=Date.now()+duration;
    while(Date.now()<until) {
      await pause(20); check(b);
      if(b.sessionId!==epoch || b.latest.t<t) throw new Error('设备重启，测试无效');
      // Current excitation may legitimately rotate multiple turns. Only new
      // board-side current/speed derating permits removing its old travel cap.
      if(expectedControl!==1 && Math.abs(b.latest.multi-origin)>25) throw new Error('位置/速度验收行程到界，本段测试结束；不是设备故障');
      if(Math.abs(b.latest.current)>.8) throw new Error(`辨识电流超限：${Math.abs(b.latest.current).toFixed(3)} A > 0.8 A`);
    }
    const samples=b.samples.filter(s=>s.t>t && s.control===expectedControl);
    if(stopAfter) await tx(b,'stop');
    return samples;
  };
  const settle=async b=>{
    let stableAt=Date.now(),position=b.latest.multi;
    const deadline=Date.now()+2500;
    while(Date.now()<deadline) {
      await pause(25); check(b);
      if(Math.abs(b.latest.multi-position)>.03 || Math.abs(b.latest.velocity)>1) {stableAt=Date.now();position=b.latest.multi;}
      if(Date.now()-stableAt>=250) return;
    }
    throw new Error('电机未停稳，请松开手柄后重试');
  };
  try {
    for(const [index,b] of pair.entries()) {
      check(b); await tx(b,'stop'); await tx(b,'wake'); await tx(b,'stream 100');
      b.interactionGuard=false;
      await tx(b,'model');
      await waitUntil(()=>b.interactionGuard===true,1500,b.port+' 尚未确认分级保护固件，未执行辨识');
      // Read actual firmware gains before taking a rollback snapshot.
      b.configDirty=false;
      b.rotorCompensation=null;
      const configuration=(await tx(b,'cascade status')).reply;
      parseLine(b,configuration);
      await waitUntil(()=>b.rotorCompensation!==null,1500,'缺少本次角度补偿回读，未修改参数');
      const originalCompensation=`cascade cogging enable ${b.rotorCompensation.scale} ${b.rotorCompensation.coulomb} ${b.rotorCompensation.offset}`;
      const assist=configuration.match(/breakaway=([\d.]+)A\/([\d.]+)ms retry=([\d.]+)ms speed=([\d.]+)deg\/s ramp=([\d.]+)A\/s/);
      if(!assist) throw new Error('缺少脱困辅助参数回读，未修改参数');
      const originalAssist='cascade breakaway '+assist.slice(1).join(' ');
      const gear=gearOf(b), kp=valueOf(b,'currentKp'), ki=valueOf(b,'currentKi'), pwm=valueOf(b,'currentMaxPwm');
      const originalCurrent=`cascade current ${kp} ${ki} ${pwm}`;
      const originalPosition=`cascade position ${valueOf(b,'positionKp')} ${valueOf(b,'positionKi')} ${valueOf(b,'positionKd')} ${parameterToMotor(b,'positionMaxVelocity')} ${parameterToMotor(b,'positionDeadband')} ${parameterToMotor(b,'positionMinVelocity')} ${b.positionAcceleration} 1`;
      const originalHold=b.positionHold;
      const velocityP=Number(parameterToMotor(b,'velocityKp')),velocityI=Number(parameterToMotor(b,'velocityKi'));
      const originalVelocity=`cascade velocity ${velocityP} ${velocityI} ${valueOf(b,'velocityMaxCurrent')} ${valueOf(b,'velocityFriction')} ${b.velocityCurrentSlew||30} ${b.velocityBrakeSlew||30}`;
      const report={port:b.port,hwid:b.hwid,date:new Date().toISOString(),originalConfiguration:configuration,originalCompensation,scope:'±5° 输出轴；0.1°容差；本次负载；非PWM纹波测量',currentTrials:[],positionTrials:[],passed:false};
      autoTune.reports.push(report);
      try { localStorage.setItem('motor-auto-tune-pending',JSON.stringify({port:b.port,hwid:b.hwid,originalCurrent,originalPosition,originalVelocity,originalAssist,originalHold,originalCompensation,date:report.date})); } catch {}
      let committed=false;
      try {
        // Do not combine freshly calculated gains with a previous motor or
        // magnet assembly's unvalidated periodic/friction compensation.
        await tx(b,`cascade cogging enable 0 ${b.rotorCompensation.coulomb} ${b.rotorCompensation.offset}`);
        report.compensationDisabledDuringTest=true;
        report.model=(await tx(b,'model')).reply;
        if(identificationOnly) {
          report.identification=[];
          // A continuous sequence rather than reset-to-STOP between speeds.
          await tx(b,`cascade velocity ${velocityP} ${velocityI} ${Math.min(.6,valueOf(b,'velocityMaxCurrent'))} ${valueOf(b,'velocityFriction')} ${b.velocityCurrentSlew||30} ${b.velocityBrakeSlew||30}`);
          const speeds=[5,15,30,15,5,-5,-15,-30,-15,-5];
          for(const [stage,speed] of speeds.entries()) {
            $('#autoState').textContent=`${b.port} · ${speed>0?'正转':'反转'} ${Math.abs(speed)}°/s · ${stage+1}/${speeds.length}`;
            const samples=await capture(b,`velocity ${serialNumber(speed*gear)} 1000 1100`,700,2,false);
            if(samples.length<40) throw new Error('辨识有效采样不足');
            const tail=samples.slice(-20),average=key=>tail.reduce((sum,s)=>sum+s[key],0)/tail.length;
            report.identification.push({targetOutputDps:speed,meanOutputDps:average('velocity'),meanCurrentA:average('current'),
              trace:samples.map(s=>({t:s.t,outputDeg:s.multi,outputDps:s.velocity,currentA:s.current,pwm:s.pwm,busV:s.bus}))});
            $('#autoProgress').value=index*50+(stage+1)*5;
          }
          await tx(b,'stop');await settle(b);
          report.identificationComplete=true;
          report.gear=gear;
          report.analysis=analyzeCapturedMotor(report);
          report.basic={direction:report.identification.every(s=>Math.abs(s.meanOutputDps)>1&&s.meanOutputDps*s.targetOutputDps>0)?'正反向一致':'存在未转动或方向不一致阶段，需检查',
            meanSpeedErrorDps:report.identification.reduce((sum,s)=>sum+Math.abs(s.meanOutputDps-s.targetOutputDps),0)/report.identification.length,
            peakSampleCurrentA:Math.max(...report.identification.flatMap(s=>s.trace.map(v=>Math.abs(v.currentA))))};
          report.scope='双向 5/15/30°/s 低速响应采集；非全速/电感/最大连续电流辨识';
          continue;
        }
        if(!report.model.includes('fw=0.5.9-sync-trace')) throw new Error('请先烧录 0.5.9 同步采样固件；旧数据仍可离线分析，未执行辨识动作');
        report.gear=gear; report.pulses=[];
        for(const ma of [200,-200,225,-225,250,-250,200,-200,225,-225,200,-200]) {
          $('#autoState').textContent=`${b.port} · 电气/机械辨识 ${ma} mA 短脉冲`;
          await tx(b,'stop');await settle(b);
          b.currentTrace=[];
          await tx(b,'trace arm 512');
          const bus=b.latest.bus;
          const pulseStart=b.latest.t;
          const duration=80;
          let samples=[],captureError=null;
          try {
            samples=await capture(b,`current ${ma} 900 ${Math.max(100,duration)}`,duration,1);
          } catch(error) {
            captureError=error;
            samples=b.samples.filter(s=>s.t>pulseStart&&s.control===1);
            report.rejectedPulse={ma,bus,error:error.message,samples:samples.map(s=>({...s})),trace:[]};
          } finally {
            await tx(b,'stop');
          }
          const meta=(await tx(b,'trace dump')).reply;
          if(typeof meta!=='string')throw new Error('高速记录缺少板端回执，未采用参数');
          const count=Number(meta.match(/count=(\d+)/)?.[1]);
          if(!Number.isInteger(count)||count<0||count>512)throw captureError||new Error('板端高速采样数量无效');
          await waitUntil(()=>b.currentTrace.length>=count,5000,'高速电流记录未收齐');
          check(b);
          const record={ma,bus,samples:samples.map(s=>({...s})),trace:b.currentTrace.slice(0,count)};
          if(captureError) {
            report.rejectedPulse={...record,error:captureError.message};
            throw captureError;
          }
          if(count<100) {
            report.rejectedPulse={...record,error:'板端高速采样不足'};
            throw new Error('板端高速采样不足');
          }
          if(samples.length<Math.floor(duration/20))throw new Error('辨识遥测不足');
          report.pulses.push(record);
        }
        // Validate the inner loop before attempting outer-loop tuning. A
        // rejected mechanical fit must not hide useful current-loop evidence.
        report.calculatedElectrical=electricalControllerFromFit(fitControlRows(movingElectricalRows(report.pulses,gear),'电气模型'),b.latest.bus);
        const calculated=report.calculatedElectrical;
        for(const scale of [1]) {
          $('#autoState').textContent=`${b.port} · 复测模型计算的电流 PI`;
          const command=`cascade current ${serialNumber(calculated.currentKp)} ${serialNumber(calculated.currentKi)} ${pwm}`;
          await tx(b,command);
          const trials=[];
          for(const ma of [150,-150]) {
            await tx(b,'stop'); await settle(b);
            b.currentTrace=[]; await tx(b,'trace arm 512');
            await capture(b,`current ${ma} 900 220`,180,1);
            const meta=(await tx(b,'trace dump')).reply;
            const count=Number(meta?.match(/count=(\d+)/)?.[1]);
            if(!Number.isInteger(count)||count<100||count>512)throw new Error('电流复测记录数量无效');
            await waitUntil(()=>b.currentTrace.length>=count,5000,'电流复测记录未收齐'); check(b);
            const trace=b.currentTrace.slice(0,count);
            trials.push({...currentTraceMetrics(trace,ma/1000),trace});
          }
          report.currentTrials.push({command,trials,score:Math.max(...trials.map(x=>x.rms)),passed:trials.every(x=>x.passed)});
        }
        const current=report.currentTrials.filter(x=>x.passed).sort((a,b)=>a.score-b.score)[0];
        if(!current) throw new Error('电流跟踪未达标，保留原参数；需检查采样或负载');
        report.calculated=calculateThreeLoopModel(report.pulses,gear,b.latest.bus);
        await tx(b,current.command); await tx(b,'cascade hold on');
        // Short-position tests use the closed-loop integral to overcome friction,
        // not an additional breakaway kick that can dominate a five-degree move.
        await tx(b,'cascade breakaway 0 '+assist.slice(2).join(' '));
        for(const candidate of report.calculated.candidates) {
          const p=candidate.positionKp,d=candidate.positionKd;
          $('#autoState').textContent=`${b.port} · 验证模型计算的速度/位置参数（正反向）`;
          const velocityCommand=`cascade velocity ${serialNumber(candidate.velocityKp)} ${serialNumber(candidate.velocityKi)} ${Math.min(.6,valueOf(b,'velocityMaxCurrent'))} 0 30 30`;
          await tx(b,velocityCommand);
          const command=`cascade position ${p} 0 ${d} ${40*gear} ${.03*gear} 0 40000 1`;
          await tx(b,command);
          await settle(b);
          const home=b.latest.multi, trials=[];
          for(const delta of [5,0,-5,0]) {
            await settle(b);
            const origin=b.latest.multi,target=home+delta;
            const motion=positionCommand(b,target,2200,3300);
            const samples=await capture(b,motion,3000,3);
            trials.push({...positionTrialMetrics(samples,origin,target),target,trace:samples.map(s=>[s.t,s.multi,s.current])});
          }
          report.positionTrials.push({command,velocityCommand,trials,passed:trials.every(x=>x.passed),score:Math.max(...trials.map(x=>x.settlingMs))});
          $('#autoProgress').value=index*50+40;
        }
        const position=report.positionTrials.filter(x=>x.passed).sort((a,b)=>a.score-b.score)[0];
        if(!position) throw new Error('没有参数通过正反向超调/误差验收，已回退原参数');
        await tx(b,position.command);
        await tx(b,position.velocityCommand);
        report.selected={current:current.command,position:position.command,velocity:position.velocityCommand,breakaway:'disabled',settlingMs:position.score};
        // Repeat the selected gains on fresh moves; never accept only a search score.
        await settle(b); const home=b.latest.multi;
        report.validation=[];
        for(const target of [home+5,home]) {
          await settle(b);
          const origin=b.latest.multi;
          report.validation.push(positionTrialMetrics(await capture(b,positionCommand(b,target,2200,3300),3000,3),origin,target));
        }
        if(!report.validation.every(x=>x.passed)) throw new Error('复测未通过，已回退原参数');
        committed=true; report.passed=true;
      } catch(error) { report.error=error.message; if(autoTune.cancelled) throw error; check(b); }
      finally {
        await tx(b,'stop');
        const restoreErrors=[];
        const restoreCommands=committed?[]:[originalCurrent,originalPosition,originalAssist,originalVelocity,originalCompensation];
        restoreCommands.push('cascade hold '+(originalHold?'on':'off'));
        for(const command of restoreCommands) {
          try { await tx(b,command); } catch(error) { restoreErrors.push(command+': '+error.message); }
        }
        if(restoreErrors.length) {
          report.passed=false; report.restoreErrors=restoreErrors;
          b.configApplied=false;
          try { localStorage.setItem('motor-auto-tune-last-report',JSON.stringify(autoTune.reports)); } catch {}
          throw new Error('参数恢复未全部确认；保持停止，保留恢复记录：'+restoreErrors.join('；'));
        }
        b.configDirty=false; b.configApplied=true; b.appliedCommands={};
        parseLine(b,(await tx(b,'cascade status')).reply);
        $('#autoReport').textContent=formatAutoReport(autoTune.reports);
        try { localStorage.setItem('motor-auto-tune-last-report',JSON.stringify(autoTune.reports)); } catch {}
        try { localStorage.removeItem('motor-auto-tune-pending'); } catch {}
      }
    }
    $('#autoProgress').value=100;
    $('#autoState').textContent=identificationOnly ? (autoTune.reports.every(r=>r.identificationComplete)?'基本检查完成：请查看方向、速度误差和工作电流；原控制参数保留。':'基本检查未完成，已停止并恢复原参数；请查看原因。') : autoTune.reports.every(r=>r.passed)?'两台整定复测通过 · 参数已应用本次连接；±5° 测试超调 ≤0.1°。更换负载后请重新整定。':'整定未全部通过；未通过的电机已回退原参数。展开测试结果查看原因。';
  } finally {
    const results=await Promise.allSettled(pair.map(b=>tx(b,'stop')));
    autoTune.active=false; document.body.classList.remove('tuning'); $('#autoTune').disabled=false;
    $('#identifyCapture').disabled=false;
    if(results.some(x=>x.status==='rejected')) throw new Error('停机回执未确认，请检查设备');
  }
}
$('#autoTune').addEventListener('click',()=>runAutoTune().catch(e=>{$('#autoState').textContent=e.message;}));
$('#identifyCapture').addEventListener('click',()=>runAutoTune(true).catch(e=>{$('#autoState').textContent=e.message;}));
try {
  const report=localStorage.getItem('motor-auto-tune-last-report');
  if(report) {
    const records=JSON.parse(report);
    $('#autoReport').textContent=formatAutoReport(records);
    $('#autoState').textContent=records.every(r=>r.identificationComplete)?'上次基本响应数据可查看；当前控制参数未被自动覆盖。':records.every(r=>r.passed)?'上次测试通过；记录仅供查看，未自动恢复运动或旧参数。':'保留上次实验记录；当前入口只做基本检查，不覆盖控制参数。';
  }
  if(localStorage.getItem('motor-auto-tune-pending')) $('#autoState').textContent='上次检查被中断；请先停止并回读参数，不会自动继续运动。';
} catch {}
function formatAutoReport(records) {
  return records.map(r=>{
    const lines=[r.port+' · '+(r.identificationComplete?'采集完成':r.passed?'复测通过':'未通过'),r.error||r.scope];
    if(r.identification) {
      lines.push('目标速度 → 实测速度（°/s） | 电流（A）');
      for(const s of r.identification)lines.push(fmt(s.targetOutputDps)+' → '+fmt(s.meanOutputDps)+' | '+fmt(s.meanCurrentA));
    }
    if(r.analysis && !r.basic) {
      const a=r.analysis;
      if(a.movingFit) lines.push(`运动电气拟合：R=${a.movingFit.coefficients[0].toFixed(3)} Ω；有效 L=${a.movingFit.coefficients[1].toExponential(3)} H；Ke=${a.movingFit.coefficients[3].toFixed(5)} V/(rad/s)；留出误差=${(100*a.movingFit.relativeError).toFixed(1)}%；仅诊断`);
      if(a.fit) lines.push(`电气初拟合 R=${a.fit.R.toFixed(3)} Ω，Ke=${a.fit.Ke.toFixed(5)} V/(rad/s)，留出误差=${a.fit.rmse.toFixed(3)} V`);
      lines.push('参数未采用：'+a.reasons.join('；'));
    }
    if(r.basic) lines.push('方向：'+r.basic.direction+'；平均速度误差 '+fmt(r.basic.meanSpeedErrorDps)+' °/s；采样峰值电流 '+fmt(r.basic.peakSampleCurrentA)+' A（非最大允许电流）');
    if(r.calculated) lines.push('已计算：R='+r.calculated.R.toFixed(3)+' Ω，有效 L='+r.calculated.effectiveL.toExponential(3)+' H；电流 PI='+r.calculated.currentKp.toFixed(2)+' / '+r.calculated.currentKi.toFixed(2));
    if(r.selected) lines.push('采用参数（本次连接）：'+JSON.stringify(r.selected));
    return lines.join('\n');
  }).join('\n\n');
}
function analyzeCapturedMotor(record) {
  const result={adopted:false,reasons:[]};
  const gear=record.gear ?? record.analysisAssumedGear;
  if(!Number.isFinite(gear)||gear<1) return {...result,reasons:['记录缺少采集时减速比，未计算']};
  if(record.pulses?.length) {
    try {
      result.movingFit=fitControlRows(movingElectricalRows(record.pulses,gear),'运动电气模型');
      const [R,L,drop,Ke]=result.movingFit.coefficients;
      if(!(R>.05&&R<20&&L>1e-6&&L<.1&&drop>=-.05&&Ke>0&&Ke<1))result.reasons.push('电气拟合系数不符合物理范围');
      calculateThreeLoopModel(record.pulses,gear,record.pulses[0].bus);
      result.reasons.push('离线计算完成，仍须新鲜电流与位置复测；没有写入参数');
    } catch(error) { result.reasons.push(error.message); }
    result.reasons.push('PWM 电压代理与 100 Hz 速度插值仍有测量误差；不把有效 L 当认证绕组电感');
    return result;
  }
  if(!record.gear) result.reasons.push('旧记录缺少减速比元数据，本次仅按设置框 '+gear+':1 作诊断假设，不能用于自动写参');
  const rows=(record.identification||[]).map(stage=>{
    const tail=(stage.trace||[]).slice(-20);
    if(tail.length<15)return null;
    const avg=fn=>tail.reduce((sum,s)=>sum+fn(s),0)/tail.length;
    const i=avg(s=>s.currentA),w=avg(s=>s.outputDps)*gear*Math.PI/180;
    return {x:[i,w,Math.sign(i)],y:avg(s=>s.busV*s.pwm/4095)};
  });
  if(rows.length<10||rows.some(r=>!r||![...r.x,r.y].every(Number.isFinite))) return {...result,reasons:['有效阶段或原始采样不足']};
  const train=rows.filter((_,i)=>i%3),test=rows.filter((_,i)=>i%3===0);
  const a=Array.from({length:3},(_,i)=>[...Array.from({length:3},(_,j)=>train.reduce((s,r)=>s+r.x[i]*r.x[j],0)),train.reduce((s,r)=>s+r.x[i]*r.y,0)]);
  for(let i=0;i<3;i++) {
    let p=i;for(let j=i+1;j<3;j++)if(Math.abs(a[j][i])>Math.abs(a[p][i]))p=j;
    [a[i],a[p]]=[a[p],a[i]];
    if(Math.abs(a[i][i])<1e-10)return {...result,reasons:['激励不独立，电阻与反电动势无法可靠分开']};
    const d=a[i][i];a[i]=a[i].map(v=>v/d);
    for(let j=0;j<3;j++)if(j!==i){const f=a[j][i];a[j]=a[j].map((v,k)=>v-f*a[i][k]);}
  }
  const [R,Ke,brush]=a.map(r=>r[3]);
  const rmse=Math.sqrt(test.reduce((s,r)=>s+(R*r.x[0]+Ke*r.x[1]+brush*r.x[2]-r.y)**2,0)/test.length);
  result.fit={R,Ke,brush,rmse};
  if(R<=0||Ke<=0||brush<0)result.reasons.push('拟合出现非物理参数');
  if(rmse>.2)result.reasons.push('留出轨迹电压误差超过 0.2 V 诊断阈值');
  result.reasons.push('当前记录只有 100 Hz 低速响应，缺少电感、电流环延迟和机械惯量验证，不能据此计算并采用三环增益');
  return result;
}
$('#analyzeCapture').addEventListener('click',()=>{
  try {
    const records=JSON.parse(localStorage.getItem('motor-auto-tune-last-report')||'[]');
    if(!Array.isArray(records)||!records.length)throw new Error('没有已有记录，请先采集');
    for(const record of records) {
      if(!record.gear)record.analysisAssumedGear=Number($('#motorGear').value);
      record.analysis=analyzeCapturedMotor(record);
    }
    localStorage.setItem('motor-auto-tune-last-report',JSON.stringify(records));
    $('#autoReport').textContent=formatAutoReport(records);
    $('#autoReport').closest('details').open=true;
    $('#autoState').textContent='已有数据已分析；下方列出拟合值或拒绝原因。没有发送运动或参数指令。';
  }catch(error){$('#autoState').textContent=error.message;}
});
$('#advancedToggle').addEventListener('click',()=>{
  const simple=document.body.classList.toggle('simple-mode');
  $('#advancedToggle').textContent=simple?'展开高级诊断与手动参数':'收起高级诊断';
  $('#advancedToggle').setAttribute('aria-expanded',String(!simple));
});
$('#simpleStrength').addEventListener('change',()=>{
  const preset={light:[10,.35,500],normal:[18,.35,1600],strong:[35,.6,1600]}[$('#simpleStrength').value];
  ['forceK','forceD','forceLimit'].forEach((id,i)=>$('#'+id).value=preset[i]); updateForceOutputs();
  forceState('手感已选择；停止后再次启动生效');
});
setInterval(()=>{
  const online=[...boards.values()].filter(b=>b.active && Date.now()-b.lastTelemetryAt<500);
  $('#simpleConnection').textContent=online.length+' / 2 台在线 · '+(autoTune.active?'正在自动整定':forceSession.active?'力反馈运行中':'待机');
},500);
await refreshPorts();
setInterval(refreshPorts, 1000);
setInterval(() => boards.forEach(pollLogs), 40);
// Haptic forces run on the board. This is only a low-rate safety lease.
setInterval(() => boards.forEach(board => renewMotion(board).catch(error => toast(error.message, true))), 250);
function stopHiddenKnobs() {
  if (autoTune.active) {
    autoTune.cancelled=true;
    boards.forEach(b=>{if(b.active) fetch('/api/send',{method:'POST',headers:{'content-type':'application/json'},keepalive:true,body:JSON.stringify({port:b.port,command:'stop'})}).catch(()=>{});});
  }
  if (forceSession.active || $('#forceStart').disabled) {
    ++forceSession.token;
    forceSession.active = false;
    boards.forEach(board => {
      if (board.active) fetch('/api/send', {method:'POST', headers:{'content-type':'application/json'}, keepalive:true,
        body:JSON.stringify({port:board.port, command:'stop', wait_ack:false})}).catch(() => {});
    });
  }
  boards.forEach(board => {
    if (board.activeMotion?.mode !== 'knob') return;
    board.activeMotion = null;
    board.motionGeneration += 1;
    clearMotionTimers(board);
    fetch('/api/send', {method:'POST', headers:{'content-type':'application/json'}, keepalive:true,
      body:JSON.stringify({port:board.port, command:'stop', wait_ack:false})}).catch(() => {});
  });
}
document.addEventListener('visibilitychange', () => { if (document.hidden) stopHiddenKnobs(); });
window.addEventListener('pagehide', stopHiddenKnobs);
requestAnimationFrame(animationFrame);
