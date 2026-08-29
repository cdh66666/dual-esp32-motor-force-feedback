#include <Arduino.h>
#include <HardwareSerial.h>
#include <Wire.h>
#include <Preferences.h>

#if defined(TINYUSB_RECOVERY_BUILD) && ARDUINO_USB_MODE != 0
#error "TinyUSB recovery build did not override ARDUINO_USB_MODE"
#endif

static constexpr const char *FW_NAME = "dual-esp32-motor-control";
static constexpr const char *FW_VERSION = "0.4.8-latched-powerpath-recovery";

// ESP32-S3-WROOM-1-N16 mapping taken from the supplied schematic.
static constexpr int PIN_ENBL = 4;       // SS6952T ENBL/IN1, PWM
static constexpr int PIN_PHASE = 5;      // SS6952T PHASE/IN2
static constexpr int PIN_NSLEEP = 6;     // SS6952T nSLEEP
static constexpr int PIN_NRESET = 7;     // SS6952T nRESET
static constexpr int PIN_I0 = 9;         // SS6952T current-step select
static constexpr int PIN_I1 = 10;
static constexpr int PIN_SDA = 11;       // MT6701 A/SDA
static constexpr int PIN_SCL = 12;       // MT6701 B/SCL
static constexpr int PIN_DECAY = 15;     // SS6952T DECAY
static constexpr int PIN_NFAULT = 18;    // SS6952T nFAULT, active low
static constexpr int PIN_LED = 21;
static constexpr int PIN_CURRENT_ADC = 1; // ADC1 / INA240 output
static constexpr int PIN_VBAT_ADC = 2;    // ADC1 / 56k:5.1k divider
static constexpr int PIN_BUS_TX = 41;
static constexpr int PIN_BUS_RX = 42;

// Keep the public controller scale at 0..4095 while using a 10-bit hardware
// timer at 20 kHz. This keeps the carrier outside the audible band without
// changing any current-loop gains or host-side command ranges.
static constexpr uint32_t PWM_HZ = 20000;
static constexpr uint32_t PWM_FALLBACK_HZ = 16000;
static constexpr uint8_t PWM_BITS = 10;
static constexpr uint8_t PWM_CH = 0;
static constexpr uint16_t PWM_TIMER_MAX = (1u << PWM_BITS) - 1;
static constexpr uint16_t PWM_MAX = 4095;
static constexpr uint32_t LOCKED_PWM_HZ = 20000;
static constexpr uint8_t LOCKED_PWM_BITS = 10;
static constexpr uint16_t LOCKED_PWM_MAX = (1u << LOCKED_PWM_BITS) - 1;
static constexpr uint16_t TEST_DUTY_MAX = PWM_MAX; // 0..4095 = 0..100% PWM
static constexpr uint32_t TEST_TIME_MAX_MS = 1000;
static constexpr float MODEL_START_CURRENT_A = 0.80f;
// Short breakaway assistance, not a user PWM ceiling. The requested 0..4095
// range remains available after the pulse; the model current limit can still
// scale it back when a rotor is stalled.
static constexpr uint16_t MODEL_START_DUTY = 180;
static constexpr float POSITION_PROFILE_MAX_DPS = 1200.0f;
static constexpr float POSITION_PROFILE_ACCEL_DPS2 = 6000.0f;
static constexpr float POSITION_PROFILE_KP_DPS_PER_DEG = 3.0f;
static constexpr float POSITION_COMMAND_MAX_DEG = 36000.0f; // +/-100 turns
static constexpr uint8_t MT6701_ADDR = 0x06;
// USB remains the human-readable console. DATA is handled separately below
// as an addressed binary half-duplex bus, so two boards never echo plain
// console text onto the shared wire.
static constexpr bool USB_ONLY_BRINGUP = true;
static constexpr uint8_t BUS_MAGIC_1 = 0xB5;
static constexpr uint8_t BUS_MAGIC_2 = 0x2B;
static constexpr uint8_t BUS_VERSION = 1;
static constexpr uint8_t BUS_BROADCAST = 0xFF;
static constexpr uint8_t BUS_MAX_PAYLOAD = 96;
static constexpr uint8_t BUS_TYPE_COMMAND = 1;
static constexpr uint8_t BUS_TYPE_RESPONSE = 2;
static constexpr uint8_t BUS_TYPE_STATUS = 3;
static constexpr uint8_t BUS_TYPE_PING = 4;
static constexpr uint8_t BUS_TYPE_PONG = 5;
static constexpr uint8_t BUS_TYPE_SYNC = 6;
static constexpr uint32_t BUS_BAUDRATE = 1000000;
static uint32_t busBaudrate = BUS_BAUDRATE;
// Match the proven Bus_Servo_Driver transport: UART1 stays enabled at all
// times. The board's Q1/U8 auto-direction circuit releases DATA after each
// stop bit; firmware never toggles BUS_TX or restarts the UART.
static HardwareSerial BusSerial(1);
static uint32_t busCrcErrorCount = 0;
static uint32_t busResyncCount = 0;
static uint32_t busRxByteCount = 0;
static uint32_t busUartErrorCount = 0;
static uint32_t busValidFrameCount = 0;
static uint32_t busAddressedFrameCount = 0;
static uint32_t busCommandRxCount = 0;
static uint32_t busFrameTxCount = 0;
static uint32_t busResponseTxCount = 0;
static constexpr uint32_t SYNC_PERIOD_US = 5000;       // 200 Hz request/response exchange
static constexpr uint32_t SYNC_LINK_TIMEOUT_US = 30000;
static constexpr uint8_t SYNC_PAYLOAD_VERSION = 1;

enum SyncMode : uint8_t {
  SYNC_OFF = 0,
  SYNC_POSITION = 1,
  SYNC_FORCE = 2,
};

struct __attribute__((packed)) SyncWirePayload {
  uint8_t version;
  uint8_t kind;       // 0=request, 1=response
  uint8_t mode;
  uint8_t reserved;
  uint32_t timestampUs;
  float positionDeg;
  float velocityDps;
  float currentMa;
  float commandPositionDeg;
  float commandVelocityDps;
  float commandCurrentMa;
  uint16_t pwm;
  uint8_t fault;
  uint8_t awake;
};
static_assert(sizeof(SyncWirePayload) == 36, "sync payload layout changed");

static bool driverAwake = false;
// Keep the software compare value as the authoritative telemetry/control
// value. On this Arduino-ESP32 release ledcRead(channel) can return the
// timer's stale readback after a pin is attached; that made the UI report
// PWM=0 even while the controller had commanded a non-zero compare value.
static volatile uint16_t commandedPwmDuty = 0;
static volatile int16_t commandedSignedPwmDuty = 0;
static double pwmConfiguredHz = 0.0;
enum BridgeDriveMode : uint8_t {
  DRIVE_SIGN_MAGNITUDE = 0,
  DRIVE_LOCKED_ANTIPHASE = 1,
};
static BridgeDriveMode bridgeDriveMode = DRIVE_SIGN_MAGNITUDE;
static bool lockedAntiphaseActive = false;
static uint8_t currentStep = 0;
static uint32_t stopAtMs = 0;
static bool positionActive = false;
static float positionTargetDeg = 0.0f;
static uint16_t positionMaxDuty = 50;
static uint32_t positionStopAtMs = 0;
static uint32_t lastPositionTickMs = 0;
static uint32_t lastPositionDebugMs = 0;
static uint32_t positionPulseOffAtMs = 0;
static uint32_t positionSettleUntilMs = 0;
static bool positionSettling = false;
static bool positionHoldActive = false;
static uint32_t positionHoldStopAtMs = 0;
static uint32_t positionHoldNextPulseMs = 0;
static bool positionLastPhase = true;
static float positionLastMultiTurnDegrees = 0.0f;
static float positionVelocityDegreesPerSecond = 0.0f;
static uint32_t positionLastSampleMs = 0;
static bool encoderTurnInitialized = false;
static uint16_t encoderPreviousRaw = 0;
static float encoderMultiTurnDegrees = 0.0f;
static float encoderLastSingleTurnDegrees = 0.0f;
static uint32_t encoderPreviousSampleUs = 0;
static uint32_t lastEncoderTrackMs = 0;
static uint8_t positionEncoderErrorCount = 0;
static bool streamEnabled = false;
static uint16_t streamRateHz = 100;
static uint32_t nextStreamAtUs = 0;
static float currentZeroMillivolts = 1650.0f;
static float currentFilteredMillivolts = 1650.0f;
static bool currentFilterInitialized = false;
static float latestCurrentMilliamps = 0.0f;
static float encoderVelocityDegreesPerSecond = 0.0f;
static float encoderRawVelocityDegreesPerSecond = 0.0f;

enum ControlMode : uint8_t {
  CONTROL_IDLE = 0,
  CONTROL_CURRENT = 1,
  CONTROL_VELOCITY = 2,
  CONTROL_POSITION = 3,
  CONTROL_IDENTIFY = 4,
};

static ControlMode controlMode = CONTROL_IDLE;
static bool modelControlActive = false;
static bool modelIdentificationEnabled = false;
static float modelTargetCurrentAmps = 0.0f;
static float modelTargetVelocityDps = 0.0f;
static float modelTargetPositionDegrees = 0.0f;
// Optional outer position PID. Its output is a velocity target; the existing
// identified current loop remains the inner actuator loop.
static bool positionPidEnabled = false;
// Direct position PID output: signed PWM counts = Kp*angle_error +
// Ki*integral_error - Kd*measured_velocity. This is intentionally separate
// from the identified model-based velocity/current loop below.
static float positionPidKp = 8.0f;             // PWM counts / deg
static float positionPidKi = 0.0f;             // PWM counts / (deg*s)
static float positionPidKd = 0.45f;            // PWM counts / (deg/s)
static float positionPidMaxPwm = PWM_MAX;
static float positionPidIntegralLimit = 600.0f; // deg*s
static float positionPidDeadbandDeg = 6.0f;
// The measured mechanism does not move reliably below about 5% duty. Apply
// this only outside the position deadband; the proportional PID value itself
// remains visible in the debug output and the clamp can be set to zero.
static float positionPidMinPwm = 220.0f;
static float positionPidIntegral = 0.0f;
static float positionPidPulseAccumulator = 0.0f;
static float latestPositionPidRawPwm = 0.0f;
static float latestPositionPidAppliedPwm = 0.0f;
static float positionPidSlewedPwm = 0.0f;
static float positionPidStallBoostPwm = 0.0f;
static bool positionPidSettled = false;
static constexpr float POSITION_PWM_SLEW_PER_SECOND = 12000.0f;
static constexpr float POSITION_STALL_BOOST_PER_SECOND = 1200.0f;
static constexpr float POSITION_STALL_BOOST_DECAY_PER_SECOND = 4000.0f;
static constexpr float POSITION_STALL_BOOST_MAX = 700.0f;
// Direction and sensor polarity are commissioning data, never a board-specific
// control algorithm. Both boards run this exact image and store only their
// local calibration in NVS.
static int8_t modelDirectionSign = 1;
static float modelMaxVelocityDps = 60000.0f; // 10,000 rpm at the motor shaft
static float modelMaxAccelerationDps2 = 60000.0f;
// The schematic sets SS6952T full-scale regulation to about 4.98 A
// (3.3 V * 10k/(16.5k+10k) VREF, 50 mOhm ISEN,
// IFS=VREF/(5*Rsense)). A command envelope up to 7 A is intentionally
// accepted for bounded commissioning tests: the measured plateau verifies
// the independent SS6952T chopper limit. Normal outer loops use their own
// lower max-current setting and never rely on this diagnostic envelope.
static constexpr float BOARD_CURRENT_LIMIT_A = 7.0f;
static float modelCurrentLimitAmps = BOARD_CURRENT_LIMIT_A;
static uint16_t modelMaxDuty = PWM_MAX;
static uint32_t modelStopAtMs = 0;
static uint32_t lastModelTickMs = 0;
static float modelCurrentIntegral = 0.0f;
static float modelVelocityIntegral = 0.0f;
static uint32_t modelStartBoostUntilMs = 0;
// Normalize each assembled board into the shared controller coordinate system
// and persist the calibration. A wrong sign makes the current PI positive
// feedback immediately, so this value is changed only by an explicit
// commissioning command.
static int8_t currentSensePolarity = 1;

// Cascaded controller: current -> velocity -> position. Each outer loop only
// commands the setpoint of the next inner loop; no outer loop writes PWM.
static constexpr uint32_t CURRENT_LOOP_PERIOD_US = 500;   // 2 kHz
static constexpr uint32_t VELOCITY_LOOP_PERIOD_US = 5000; // 200 Hz
static constexpr uint32_t POSITION_VELOCITY_LOOP_PERIOD_US = 2000; // 500 Hz position velocity
static constexpr uint32_t POSITION_LOOP_PERIOD_US = 5000;// 200 Hz position
static float cascadeCurrentKp = 400.0f;      // PWM counts / A
static float cascadeCurrentKi = 1800.0f;     // PWM counts / (A*s)
static float cascadeVelocityKp = 0.0005f;    // A / (deg/s)
static float cascadeVelocityKi = 0.0010f;    // A / deg
static float cascadeVelocityFrictionA = 2.2f; // measured breakaway-current ceiling
static float cascadePositionKp = 4.0f;       // (deg/s) / deg
static float cascadePositionKi = 0.0f;       // (deg/s) / (deg*s)
static float cascadePositionKd = 0.25f;      // (deg/s) / (deg/s)
static float cascadePositionReverseKdScale = 1.0f;
static float cascadePositionMaxVelocityDps = 60.0f;
static float cascadePositionMinVelocityDps = 0.0f;
static float cascadePositionDeadbandDeg = 0.10f;
static float cascadePositionLowSpeedCurrentA = 2.0f;
static float cascadeVelocityMaxCurrentA = 4.8f;
static float cascadeCurrentMaxPwm = 4095.0f;
static float cascadeVelocityRequestedDps = 0.0f;
static float cascadeVelocityCommandDps = 0.0f;
static float cascadeCurrentCommandA = 0.0f;
static float cascadeMeasuredCurrentA = 0.0f;
static float cascadeSignedPwm = 0.0f;
static float cascadePositionIntegral = 0.0f;
static float cascadeVelocityIntegral = 0.0f;
static float cascadeCurrentIntegral = 0.0f;
static float cascadeVelocityBreakawayA = 0.0f;
static bool cascadeVelocityStictionActive = false;
// The validated current PI can follow a much faster reference than the old
// 10 A/s outer-loop limiter allowed. Use 30 A/s for large velocity errors;
// the velocity loop below automatically softens this close to the target.
static float cascadeVelocityCurrentSlewAps = 30.0f;
static float cascadeVelocityBrakeSlewMultiplier = 30.0f;
static float cascadePositionMaxAccelerationDps2 = 100000.0f;
static float cascadePositionMaxJerkDps3 = 1200.0f;
static float cascadeTrajectoryBandwidthRadS = 3.0f;
static float cascadeTrajectoryPositionDeg = 0.0f;
static float cascadeTrajectoryVelocityDps = 0.0f;
static float cascadeTrajectoryAccelerationDps2 = 0.0f;
static float cascadeBreakawayFeedForwardA = 0.0f;
static float cascadeBreakawayPulseCurrentA = 2.2f;
static float cascadeBreakawayPulseMs = 25.0f;
static float cascadeBreakawayRetryMs = 120.0f;
static float cascadeBreakawayPulseSpeedDps = 120.0f;
static float cascadeBreakawayRampAps = 200.0f;
static bool cascadeBreakawayPulseActive = false;
static uint32_t cascadeBreakawayPulseUntilUs = 0;
static uint32_t cascadeBreakawayLastAttemptUs = 0;
static bool cascadeBreakawayPulseReleasePending = false;
static float cascadeBreakawayStartPositionDeg = 0.0f;
static int8_t cascadeBreakawayDirectionSign = 1;
static uint8_t cascadeBreakawayMotionTicks = 0;
// Release a position command once the rotor is close and slow. The motor's
// cogging torque can then choose the nearest quiet detent instead of a
// high-bandwidth controller repeatedly reversing around the target.
static constexpr float CASCADE_POSITION_RELEASE_WINDOW_DEG = 3.0f;
static constexpr float CASCADE_POSITION_RELEASE_SPEED_DPS = 12.0f;
static constexpr float CASCADE_POSITION_RELEASE_COMMAND_DPS = 25.0f;
static constexpr float CASCADE_POSITION_DIRECTIONAL_APPROACH_WINDOW_DEG = 12.0f;
// Direct velocity retargets use the identified high-speed acceleration
// envelope.  This is independent of the deliberately conservative position
// approach profile, so changing the position slider cannot make a velocity
// command dip to zero or crawl through a retarget.
// Do not cascade two slow ramps. Direct velocity setpoints move to the new
// target quickly and the current-reference limiter remains the single,
// physically meaningful torque slew limit. At the UI maximum of 60000 dps
// this still takes 100 ms, while a 3000 dps retarget takes one 200 Hz tick.
static constexpr float CASCADE_DIRECT_VELOCITY_ACCELERATION_DPS2 = 600000.0f;
static constexpr float CASCADE_VELOCITY_QUIET_CURRENT_SLEW_A_PER_S = 12.0f;
static constexpr float CASCADE_VELOCITY_FULL_RESPONSE_ERROR_DPS = 500.0f;
static bool cascadePositionReleased = false;
static float cascadeBusVoltage = 0.0f;
static uint32_t cascadeLastCurrentUs = 0;
static uint32_t cascadeLastVelocityUs = 0;
static uint32_t cascadeLastPositionUs = 0;
static uint32_t cascadeNoCurrentResponseSinceMs = 0;
static bool powerPathFaultLatched = false;
static bool cascadePositionSettled = false;
static float modelResistanceOhm = 2.0f;
static float modelKeVoltSecondsPerRad = 0.011f;
static float modelKtNmPerAmp = 0.011f;
static float modelInertiaKgM2 = 0.00002f;
static float modelViscousFriction = 0.000001f;
static bool modelHasElectricalFit = false;
static bool modelHasMechanicalFit = false;
static float electricalTheta[2] = {2.0f, 0.011f};
static float electricalCovariance[2][2] = {{100.0f, 0.0f}, {0.0f, 100.0f}};
static float mechanicalTheta[2] = {550.0f, 0.05f};
static float mechanicalCovariance[2][2] = {{1000.0f, 0.0f}, {0.0f, 1000.0f}};
static float modelPreviousVelocityRadPerSecond = 0.0f;
static uint32_t modelPreviousSampleUs = 0;
static uint32_t modelElectricalSamples = 0;
static uint32_t modelMechanicalSamples = 0;
static bool identificationRunActive = false;
static uint8_t identificationPhase = 0;
static uint32_t identificationPhaseUntilMs = 0;
static String line;
static uint8_t busAddress = 1;
static uint8_t busSequence = 0;
static bool busTransactionActive = false;
static uint8_t busPendingDestination = 0;
static uint8_t busPendingSequence = 0;
static uint8_t busPendingType = 0;
static uint8_t busPendingLength = 0;
static uint8_t busPendingPayload[BUS_MAX_PAYLOAD] = {};
static uint8_t busPendingRetries = 0;
static uint32_t busPendingDeadlineMs = 0;
static SyncMode syncMode = SYNC_OFF;
static uint8_t syncPeerAddress = 0;
static bool syncMotionArmed = false;
static uint16_t syncMaxDuty = PWM_MAX;
static uint32_t syncTimeoutMs = 30000;
static float syncPositionOffsetDeg = 0.0f;
static float syncStiffnessMaPerDeg = 15.0f;
static float syncDampingMaPerDps = 0.4f;
static float syncReflectionGain = 0.0f;
static float syncCurrentLimitMa = 500.0f;
static uint32_t syncNextTxUs = 0;
static uint32_t syncLastTxUs = 0;
static uint32_t syncLastRxUs = 0;
static uint8_t syncSequence = 0;
static uint32_t syncTxCount = 0;
static uint32_t syncRxCount = 0;
static uint32_t syncRequestTxCount = 0;
static uint32_t syncResponseTxCount = 0;
static uint32_t syncRequestRxCount = 0;
static uint32_t syncResponseRxCount = 0;
static bool syncLinkFailed = false;
static uint32_t syncTimeoutCount = 0;
static bool syncControlRunning = false;
static float syncRemotePositionDeg = 0.0f;
static float syncRemoteVelocityDps = 0.0f;
static float syncRemoteCurrentMa = 0.0f;
static float syncRemoteCommandPositionDeg = 0.0f;
static float syncRemoteCommandVelocityDps = 0.0f;
static float syncRemoteCommandCurrentMa = 0.0f;
static uint16_t syncRemotePwm = 0;
static uint8_t syncRemoteFault = 0;
static uint8_t syncRemoteAwake = 0;

static void setModelPhase(float commandSign) {
  digitalWrite(PIN_PHASE, commandSign * static_cast<float>(modelDirectionSign) > 0.0f ? HIGH : LOW);
}

class DualConsole final : public Print {
 public:
  size_t write(uint8_t byte) override {
    const size_t a = Serial.write(byte);
    if (USB_ONLY_BRINGUP) return a;
    const size_t b = BusSerial.write(byte);
    return (a && b) ? 1 : 0;
  }
};

static DualConsole Console;

static bool configurePwmHardware() {
  pwmConfiguredHz = ledcSetup(PWM_CH, PWM_HZ, PWM_BITS);
  if (pwmConfiguredHz <= 0.0) {
    pwmConfiguredHz = ledcSetup(PWM_CH, PWM_FALLBACK_HZ, PWM_BITS);
  }
  if (pwmConfiguredHz <= 0.0) {
    commandedPwmDuty = 0;
    pinMode(PIN_ENBL, OUTPUT);
    digitalWrite(PIN_ENBL, LOW);
    return false;
  }
  ledcAttachPin(PIN_ENBL, PWM_CH);
  commandedPwmDuty = 0;
  commandedSignedPwmDuty = 0;
  lockedAntiphaseActive = false;
  ledcWrite(PWM_CH, 0);
  return true;
}

static void setPwm(uint16_t duty) {
  if (duty > TEST_DUTY_MAX) duty = TEST_DUTY_MAX;
  commandedPwmDuty = duty;
  if (duty == 0) {
    commandedSignedPwmDuty = 0;
  } else {
    const bool positivePhase = digitalRead(PIN_PHASE) ==
                               (modelDirectionSign > 0 ? HIGH : LOW);
    commandedSignedPwmDuty = static_cast<int16_t>(
        positivePhase ? duty : -static_cast<int32_t>(duty));
  }
  const uint16_t timerDuty = static_cast<uint16_t>(
      (static_cast<uint32_t>(duty) * PWM_TIMER_MAX + PWM_MAX / 2u) /
      PWM_MAX);
  ledcWrite(PWM_CH, timerDuty);
}

static void applyCascadeBridgePwm(float signedPwm) {
  signedPwm = constrain(signedPwm, -static_cast<float>(PWM_MAX),
                        static_cast<float>(PWM_MAX));
  if (bridgeDriveMode == DRIVE_LOCKED_ANTIPHASE) {
    if (!lockedAntiphaseActive) {
      // Prepare PHASE PWM at its zero-average midpoint before enabling the
      // bridge. This avoids a one-cycle full-polarity pulse during remapping.
      ledcWrite(PWM_CH, 0);
      ledcDetachPin(PIN_ENBL);
      pinMode(PIN_ENBL, OUTPUT);
      digitalWrite(PIN_ENBL, LOW);
      pinMode(PIN_PHASE, OUTPUT);
      ledcAttachPin(PIN_PHASE, PWM_CH);
      ledcWrite(PWM_CH, (PWM_TIMER_MAX + 1u) / 2u);
      delayMicroseconds(5);
      digitalWrite(PIN_ENBL, HIGH);
      lockedAntiphaseActive = true;
    }
    const int32_t center = (PWM_TIMER_MAX + 1u) / 2u;
    const int32_t directedPwm = lroundf(signedPwm) * modelDirectionSign;
    const uint16_t phaseDuty = static_cast<uint16_t>(constrain(
        center + directedPwm * static_cast<int32_t>(PWM_TIMER_MAX) /
                     (2 * static_cast<int32_t>(PWM_MAX)),
        0L, static_cast<long>(PWM_TIMER_MAX)));
    commandedSignedPwmDuty = static_cast<int16_t>(lroundf(signedPwm));
    commandedPwmDuty = static_cast<uint16_t>(abs(commandedSignedPwmDuty));
    ledcWrite(PWM_CH, phaseDuty);
    return;
  }
  if (lockedAntiphaseActive) {
    digitalWrite(PIN_ENBL, LOW);
    ledcDetachPin(PIN_PHASE);
    pinMode(PIN_PHASE, OUTPUT);
    digitalWrite(PIN_PHASE, LOW);
    configurePwmHardware();
  }
  if (fabsf(signedPwm) < 0.5f) {
    setPwm(0);
  } else {
    setModelPhase(signedPwm > 0.0f ? 1.0f : -1.0f);
    setPwm(static_cast<uint16_t>(fabsf(signedPwm)));
  }
}

static void disableBridgeOutput() {
  if (!lockedAntiphaseActive) {
    setPwm(0);
    return;
  }
  // ENBL low is the immediate safe action. Restore ordinary ENBL PWM so all
  // manual diagnostics continue to use the documented sign-magnitude path.
  digitalWrite(PIN_ENBL, LOW);
  ledcDetachPin(PIN_PHASE);
  pinMode(PIN_PHASE, OUTPUT);
  digitalWrite(PIN_PHASE, LOW);
  configurePwmHardware();
}

static uint16_t pwmDuty() {
  return commandedPwmDuty;
}

static int16_t signedPwmDuty() {
  return commandedSignedPwmDuty;
}

static void motorStop() {
  disableBridgeOutput();
  syncMotionArmed = false;
  syncControlRunning = false;
  // STOP must cancel every actuator owner. Previously the position-loop
  // state survived STOP, so positionControlTick() ran again on the next
  // iteration and cleared any later CW/CCW/POS command back to PWM=0.
  positionActive = false;
  positionSettling = false;
  positionHoldActive = false;
  positionPulseOffAtMs = 0;
  positionStopAtMs = 0;
  positionHoldStopAtMs = 0;
  positionHoldNextPulseMs = 0;
  stopAtMs = 0;
  modelControlActive = false;
  controlMode = CONTROL_IDLE;
  modelStopAtMs = 0;
  modelCurrentIntegral = 0.0f;
  modelVelocityIntegral = 0.0f;
  positionPidIntegral = 0.0f;
  positionPidPulseAccumulator = 0.0f;
  latestPositionPidRawPwm = 0.0f;
  latestPositionPidAppliedPwm = 0.0f;
  positionPidSlewedPwm = 0.0f;
  positionPidStallBoostPwm = 0.0f;
  positionPidSettled = false;
  cascadeVelocityRequestedDps = 0.0f;
  cascadeVelocityCommandDps = 0.0f;
  cascadeCurrentCommandA = 0.0f;
  cascadeMeasuredCurrentA = 0.0f;
  cascadeSignedPwm = 0.0f;
  cascadePositionIntegral = 0.0f;
  cascadeVelocityIntegral = 0.0f;
  cascadeCurrentIntegral = 0.0f;
  cascadeNoCurrentResponseSinceMs = 0;
  cascadeVelocityBreakawayA = 0.0f;
  cascadeVelocityStictionActive = false;
  cascadeTrajectoryPositionDeg = encoderMultiTurnDegrees;
  cascadeTrajectoryVelocityDps = 0.0f;
  cascadeTrajectoryAccelerationDps2 = 0.0f;
  cascadeBreakawayFeedForwardA = 0.0f;
  cascadeBreakawayPulseActive = false;
  cascadeBreakawayPulseUntilUs = 0;
  cascadeBreakawayLastAttemptUs = 0;
  cascadeBreakawayPulseReleasePending = false;
  cascadeBreakawayStartPositionDeg = encoderMultiTurnDegrees;
  cascadeBreakawayDirectionSign = 1;
  cascadeBreakawayMotionTicks = 0;
  cascadePositionReleased = false;
  cascadeLastCurrentUs = 0;
  cascadeLastVelocityUs = 0;
  cascadeLastPositionUs = 0;
  cascadePositionSettled = false;
  modelStartBoostUntilMs = 0;
  // Do not carry a PWM-on sample into the idle telemetry after a stop. The
  // next ADC read will seed the filter from the actual bridge state.
  currentFilterInitialized = false;
  positionActive = false;
  positionStopAtMs = 0;
  positionPulseOffAtMs = 0;
  positionSettleUntilMs = 0;
  positionSettling = false;
  positionHoldActive = false;
  positionHoldStopAtMs = 0;
  positionHoldNextPulseMs = 0;
  positionEncoderErrorCount = 0;
  identificationRunActive = false;
  identificationPhase = 0;
  identificationPhaseUntilMs = 0;
}

static bool readEncoder(uint16_t &raw, float &degrees) {
  Wire.beginTransmission(MT6701_ADDR);
  Wire.write(0x03);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)MT6701_ADDR, 2) != 2) return false;
  const uint8_t hi = Wire.read();
  const uint8_t lo = Wire.read();
  raw = (static_cast<uint16_t>(hi) << 6) | (lo >> 2);
  degrees = static_cast<float>(raw) * 360.0f / 16384.0f;
  const uint32_t nowUs = micros();
  if (!encoderTurnInitialized) {
    encoderPreviousRaw = raw;
    encoderMultiTurnDegrees = degrees;
    encoderLastSingleTurnDegrees = degrees;
    encoderVelocityDegreesPerSecond = 0.0f;
    encoderRawVelocityDegreesPerSecond = 0.0f;
    encoderPreviousSampleUs = nowUs;
    encoderTurnInitialized = true;
  } else {
    int32_t delta = static_cast<int32_t>(raw) - static_cast<int32_t>(encoderPreviousRaw);
    if (delta > 8192) delta -= 16384;
    if (delta < -8192) delta += 16384;
    // MT6701 has no CRC on this readout. A transient I2C bit error can look
    // like a valid 14-bit angle and slowly add fake turns to the accumulator.
    // Reject jumps beyond a generous 20,000 rpm physical limit. Keep the
    // previous accepted raw value so the next good sample can recover.
    const uint32_t dtUs = max<uint32_t>(1, nowUs - encoderPreviousSampleUs);
    const float maxCounts = min(8000.0f, max(256.0f,
        120000.0f * static_cast<float>(dtUs) / 1000000.0f * 16384.0f / 360.0f + 512.0f));
    if (fabsf(static_cast<float>(delta)) > maxCounts) return false;
    const float deltaDegrees = static_cast<float>(delta) * 360.0f / 16384.0f;
    const float measuredVelocity = deltaDegrees * 1000000.0f / static_cast<float>(dtUs);
    encoderRawVelocityDegreesPerSecond = measuredVelocity;
    // The encoder is sampled faster than the telemetry stream. Filter the
    // differentiated angle once here so both control and UI use the same
    // accepted multi-turn trajectory rather than two different velocities.
    // At a 500 Hz position sample, one MT6701 count is already about
    // 11 deg/s. Feeding 35% of that quantised delta into the position D
    // term made a stationary shaft look like alternating motion. Keep the
    // raw sample for diagnostics, but use a slower controller estimate.
    encoderVelocityDegreesPerSecond = encoderVelocityDegreesPerSecond * 0.85f + measuredVelocity * 0.15f;
    encoderMultiTurnDegrees += deltaDegrees;
    encoderPreviousRaw = raw;
    encoderLastSingleTurnDegrees = degrees;
    encoderPreviousSampleUs = nowUs;
  }
  return true;
}

static bool rebaseEncoderMultiTurn() {
  uint16_t raw = 0;
  float degrees = 0.0f;
  if (!readEncoder(raw, degrees)) return false;
  encoderPreviousRaw = raw;
  // The MT6701 reports an absolute single-turn angle.  A rebase is a user
  // zero operation: keep the raw angle as the unwrap origin, but expose the
  // present mechanical position as exactly 0 degrees on the multi-turn axis.
  encoderMultiTurnDegrees = 0.0f;
  encoderLastSingleTurnDegrees = degrees;
  encoderVelocityDegreesPerSecond = 0.0f;
  encoderRawVelocityDegreesPerSecond = 0.0f;
  encoderPreviousSampleUs = micros();
  encoderTurnInitialized = true;
  return true;
}

static void encoderTrackingTick() {
  const uint32_t now = millis();
  if (now - lastEncoderTrackMs < 1) return;
  lastEncoderTrackMs = now;
  uint16_t raw = 0;
  float degrees = 0.0f;
  // Keep the multi-turn accumulator alive during manual motion too. The
  // 100 Hz telemetry frame is not fast enough to unwrap a fast 775 rotor by
  // itself; tracking at 1 kHz prevents a 0..360 single-turn display from
  // being mistaken for a lost multi-turn count.
  readEncoder(raw, degrees);
}

static float readBusVoltage(float *adcMillivolts = nullptr) {
  const float mv = static_cast<float>(analogReadMilliVolts(PIN_VBAT_ADC));
  if (adcMillivolts) *adcMillivolts = mv;
  // R23=56k from VBAT to ADC, R26=5.1k from ADC to GND.
  return mv * (56.0f + 5.1f) / 5.1f / 1000.0f;
}

static float readCurrentSenseMillivolts() {
  // INA240 output is sampled while the bridge PWM is switching. Average a
  // short burst so one ADC conversion does not become a fake ampere-scale
  // spike in the 100 Hz telemetry stream.
  uint32_t total = 0;
  for (uint8_t i = 0; i < 8; ++i) {
    total += static_cast<uint32_t>(analogReadMilliVolts(PIN_CURRENT_ADC));
  }
  return static_cast<float>(total) / 8.0f;
}

static float filterCurrentSenseMillivolts(float rawMillivolts) {
  if (!currentFilterInitialized) {
    currentFilteredMillivolts = rawMillivolts;
    currentFilterInitialized = true;
    return currentFilteredMillivolts;
  }
  // Keep movement current responsive while smoothing the PWM carrier ripple;
  // use a slower idle coefficient so the displayed zero does not wander.
  // Locked-antiphase modulation applies both bridge polarities every PWM
  // period. Its zero-mean carrier is much larger than the commanded average
  // current, so the sign-magnitude coefficient aliases carrier ripple into
  // the 2 kHz PI loop. Use a dedicated low-pass coefficient while PHASE PWM
  // is active; ordinary ENBL PWM keeps the faster shared response.
  const float alpha = lockedAntiphaseActive ? 0.06f :
                      (pwmDuty() == 0 ? 0.12f : 0.28f);
  currentFilteredMillivolts += (rawMillivolts - currentFilteredMillivolts) * alpha;
  return currentFilteredMillivolts;
}

static float readSignedCurrentMilliamps(float currentMillivolts) {
  // INA240A1 gain=20 and R15=10mΩ: 0.2V/A. The REF/ADC zero is measured
  // at boot because the real 3V3 rail and ADC have offset.
  return (currentMillivolts - currentZeroMillivolts) * 5.0f *
         static_cast<float>(currentSensePolarity);
}

static void trackCurrentZeroAtIdle(float currentMillivolts) {
  // With PWM=0 the H-bridge has no commanded motor current. Track the INA240
  // reference/ADC drift slowly so the displayed branch current does not turn
  // a few millivolts of thermal/ADC drift into a false hundred-milliamp value.
  if (pwmDuty() != 0 || positionActive || modelControlActive ||
      identificationRunActive || !driverAwake) return;
  currentZeroMillivolts += (currentMillivolts - currentZeroMillivolts) * 0.08f;
}

static void calibrateCurrentZero() {
  setPwm(0);
  uint32_t total = 0;
  for (int i = 0; i < 32; ++i) {
    total += static_cast<uint32_t>(analogReadMilliVolts(PIN_CURRENT_ADC));
    delay(2);
  }
  currentZeroMillivolts = static_cast<float>(total) / 32.0f;
  currentFilteredMillivolts = currentZeroMillivolts;
  currentFilterInitialized = true;
}

static void runDirectBridgeTest(bool forward, uint16_t durationMs) {
  motorStop();
  if (!driverAwake || digitalRead(PIN_NFAULT) == LOW) {
    Console.println("ERR dctest requires awake driver and nFAULT=1");
    return;
  }
  digitalWrite(PIN_I0, HIGH);
  digitalWrite(PIN_I1, HIGH);
  currentStep = 3;
  digitalWrite(PIN_PHASE, forward ? HIGH : LOW);
  const float startDegrees = encoderMultiTurnDegrees;
  const float startBusV = readBusVoltage();
  float peakAbsCurrentMa = 0.0f;
  float minBusV = startBusV;
  float maxBusV = startBusV;
  float minCurrentMv = 100000.0f;
  float maxCurrentMv = -100000.0f;
  uint8_t faultSeen = static_cast<uint8_t>(digitalRead(PIN_NFAULT));
  uint8_t enblMin = 1;
  uint8_t enblMax = 0;
  uint8_t phaseMin = 1;
  uint8_t phaseMax = 0;
  uint8_t sleepMin = 1;
  uint8_t resetMin = 1;
  uint8_t i0Min = 1;
  uint8_t i1Min = 1;
  // Bypass LEDC and the GPIO matrix for this bounded diagnostic. If this
  // direct HIGH test still produces no branch current, the remaining path is
  // outside the PWM software: driver/output/shunt/connector/motor.
  ledcDetachPin(PIN_ENBL);
  pinMode(PIN_ENBL, OUTPUT);
  digitalWrite(PIN_ENBL, HIGH);
  const uint32_t stopAt = millis() + durationMs;
  while (static_cast<int32_t>(millis() - stopAt) < 0) {
    uint16_t raw = 0;
    float single = 0.0f;
    readEncoder(raw, single);
    const float currentMv = readCurrentSenseMillivolts();
    const float currentMa = readSignedCurrentMilliamps(currentMv);
    const float busV = readBusVoltage();
    peakAbsCurrentMa = max(peakAbsCurrentMa, fabsf(currentMa));
    minCurrentMv = min(minCurrentMv, currentMv);
    maxCurrentMv = max(maxCurrentMv, currentMv);
    minBusV = min(minBusV, busV);
    maxBusV = max(maxBusV, busV);
    faultSeen = min<uint8_t>(faultSeen, static_cast<uint8_t>(digitalRead(PIN_NFAULT)));
    const uint8_t enbl = static_cast<uint8_t>(digitalRead(PIN_ENBL));
    const uint8_t phase = static_cast<uint8_t>(digitalRead(PIN_PHASE));
    enblMin = min<uint8_t>(enblMin, enbl);
    enblMax = max<uint8_t>(enblMax, enbl);
    phaseMin = min<uint8_t>(phaseMin, phase);
    phaseMax = max<uint8_t>(phaseMax, phase);
    sleepMin = min<uint8_t>(sleepMin,
                            static_cast<uint8_t>(digitalRead(PIN_NSLEEP)));
    resetMin = min<uint8_t>(resetMin,
                            static_cast<uint8_t>(digitalRead(PIN_NRESET)));
    i0Min = min<uint8_t>(i0Min,
                         static_cast<uint8_t>(digitalRead(PIN_I0)));
    i1Min = min<uint8_t>(i1Min,
                         static_cast<uint8_t>(digitalRead(PIN_I1)));
    delayMicroseconds(500);
  }
  digitalWrite(PIN_ENBL, LOW);
  const bool pwmRestored = configurePwmHardware();
  Console.printf("DC_TEST dir=%s duration=%ums delta=%.2fdeg peak_current=%.0fmA current_adc=%.0f..%.0fmV bus=%.2f..%.2fV(start=%.2fV) pins=enbl:%u..%u phase:%u..%u sleep:%u reset:%u i0:%u i1:%u nfault_min=%u pwm_restore=%d pwm_hz=%.0f enbl_after=%d\n",
                forward ? "cw" : "ccw", static_cast<unsigned>(durationMs),
                encoderMultiTurnDegrees - startDegrees, peakAbsCurrentMa,
                minCurrentMv, maxCurrentMv, minBusV, maxBusV, startBusV,
                static_cast<unsigned>(enblMin), static_cast<unsigned>(enblMax),
                static_cast<unsigned>(phaseMin), static_cast<unsigned>(phaseMax),
                static_cast<unsigned>(sleepMin), static_cast<unsigned>(resetMin),
                static_cast<unsigned>(i0Min), static_cast<unsigned>(i1Min),
                static_cast<unsigned>(faultSeen), pwmRestored ? 1 : 0,
                pwmConfiguredHz, digitalRead(PIN_ENBL));
}

static void runLockedAntiphaseTest(int16_t offsetCounts, uint16_t durationMs) {
  motorStop();
  if (!driverAwake || digitalRead(PIN_NFAULT) == LOW) {
    Console.println("ERR lapatest requires awake driver and nFAULT=1");
    return;
  }
  digitalWrite(PIN_I0, HIGH);
  digitalWrite(PIN_I1, HIGH);
  currentStep = 3;
  ledcDetachPin(PIN_ENBL);
  pinMode(PIN_ENBL, OUTPUT);
  digitalWrite(PIN_ENBL, HIGH);
  pinMode(PIN_PHASE, OUTPUT);
  pwmConfiguredHz = ledcSetup(PWM_CH, LOCKED_PWM_HZ, LOCKED_PWM_BITS);
  if (pwmConfiguredHz <= 0.0) {
    digitalWrite(PIN_ENBL, LOW);
    configurePwmHardware();
    Console.println("ERR lapatest locked PWM setup failed");
    return;
  }
  ledcAttachPin(PIN_PHASE, PWM_CH);
  const int32_t center = (LOCKED_PWM_MAX + 1u) / 2u;
  const uint16_t phaseDuty = static_cast<uint16_t>(constrain(
      center + static_cast<int32_t>(offsetCounts) * modelDirectionSign / 4,
      0L, static_cast<long>(LOCKED_PWM_MAX)));
  commandedPwmDuty = static_cast<uint16_t>(abs(offsetCounts) * 2);
  ledcWrite(PWM_CH, phaseDuty);
  const float startDegrees = encoderMultiTurnDegrees;
  float peakAbsCurrentMa = 0.0f;
  float sumCurrentMa = 0.0f;
  uint32_t samples = 0;
  uint8_t faultSeen = static_cast<uint8_t>(digitalRead(PIN_NFAULT));
  const uint32_t stopAtUs = micros() + static_cast<uint32_t>(durationMs) * 1000u;
  while (static_cast<int32_t>(micros() - stopAtUs) < 0) {
    uint16_t raw = 0;
    float single = 0.0f;
    readEncoder(raw, single);
    const float currentMa = readSignedCurrentMilliamps(
        readCurrentSenseMillivolts());
    peakAbsCurrentMa = max(peakAbsCurrentMa, fabsf(currentMa));
    sumCurrentMa += currentMa;
    ++samples;
    faultSeen = min<uint8_t>(faultSeen,
        static_cast<uint8_t>(digitalRead(PIN_NFAULT)));
    if (faultSeen == 0) break;
  }
  ledcWrite(PWM_CH, center);
  delayMicroseconds(250);
  ledcDetachPin(PIN_PHASE);
  pinMode(PIN_PHASE, OUTPUT);
  digitalWrite(PIN_PHASE, LOW);
  digitalWrite(PIN_ENBL, LOW);
  const bool pwmRestored = configurePwmHardware();
  Console.printf("LAPA_TEST offset=%d/2048 duration=%ums delta=%.3fdeg avg_current=%.0fmA peak_current=%.0fmA nfault_min=%u samples=%lu pwm_restore=%d\n",
                static_cast<int>(offsetCounts), static_cast<unsigned>(durationMs),
                encoderMultiTurnDegrees - startDegrees,
                samples == 0 ? 0.0f : sumCurrentMa / static_cast<float>(samples),
                peakAbsCurrentMa, static_cast<unsigned>(faultSeen),
                static_cast<unsigned long>(samples), pwmRestored ? 1 : 0);
}

static void resetMotorModel() {
  modelResistanceOhm = 2.0f;
  modelKeVoltSecondsPerRad = 0.011f;
  modelKtNmPerAmp = 0.011f;
  modelInertiaKgM2 = 0.00002f;
  modelViscousFriction = 0.000001f;
  electricalTheta[0] = modelResistanceOhm;
  electricalTheta[1] = modelKeVoltSecondsPerRad;
  electricalCovariance[0][0] = 100.0f;
  electricalCovariance[0][1] = 0.0f;
  electricalCovariance[1][0] = 0.0f;
  electricalCovariance[1][1] = 100.0f;
  // Initial estimate for a 775-class rotor. It is only a starting point; the
  // bounded RLS identification below replaces it when excitation data exists.
  mechanicalTheta[0] = 2500.0f; // rad/s² per A
  mechanicalTheta[1] = 0.5f;
  mechanicalCovariance[0][0] = 1000.0f;
  mechanicalCovariance[0][1] = 0.0f;
  mechanicalCovariance[1][0] = 0.0f;
  mechanicalCovariance[1][1] = 1000.0f;
  modelElectricalSamples = 0;
  modelMechanicalSamples = 0;
  modelHasElectricalFit = false;
  modelHasMechanicalFit = false;
  modelPreviousVelocityRadPerSecond = 0.0f;
  modelPreviousSampleUs = 0;
}

static void saveMotorModel() {
  Preferences preferences;
  if (!preferences.begin("motormodel", false)) return;
  preferences.putFloat("r_ohm", modelResistanceOhm);
  preferences.putFloat("ke_vsr", modelKeVoltSecondsPerRad);
  preferences.putFloat("acc_per_a", mechanicalTheta[0]);
  preferences.putFloat("friction", mechanicalTheta[1]);
  preferences.putBool("elec_fit", modelHasElectricalFit);
  preferences.putBool("mech_fit", modelHasMechanicalFit);
  preferences.putChar("dir", modelDirectionSign);
  preferences.putChar("sense", currentSensePolarity);
  preferences.end();
}

static void loadMotorModel() {
  Preferences preferences;
  if (!preferences.begin("motormodel", true)) return;
  if (preferences.getBool("elec_fit", false)) {
    modelResistanceOhm = constrain(preferences.getFloat("r_ohm", modelResistanceOhm), 0.05f, 20.0f);
    modelKeVoltSecondsPerRad = constrain(preferences.getFloat("ke_vsr", modelKeVoltSecondsPerRad), 0.0001f, 0.2f);
    electricalTheta[0] = modelResistanceOhm;
    electricalTheta[1] = modelKeVoltSecondsPerRad;
    modelHasElectricalFit = true;
  }
  if (preferences.getBool("mech_fit", false)) {
    mechanicalTheta[0] = constrain(preferences.getFloat("acc_per_a", mechanicalTheta[0]), 200.0f, 200000.0f);
    mechanicalTheta[1] = constrain(preferences.getFloat("friction", mechanicalTheta[1]), 0.0f, 100.0f);
    modelHasMechanicalFit = true;
  }
  const int8_t storedDirection = preferences.getChar("dir", 1);
  modelDirectionSign = storedDirection < 0 ? -1 : 1;
  const int8_t storedSensePolarity = preferences.getChar("sense", 1);
  currentSensePolarity = storedSensePolarity < 0 ? -1 : 1;
  preferences.end();
}

static void rlsUpdate2(float theta[2], float covariance[2][2], float phi0, float phi1,
                       float measurement, float forgetting = 0.995f) {
  const float p0 = covariance[0][0] * phi0 + covariance[0][1] * phi1;
  const float p1 = covariance[1][0] * phi0 + covariance[1][1] * phi1;
  const float denominator = forgetting + phi0 * p0 + phi1 * p1;
  if (denominator <= 0.000001f) return;
  const float k0 = p0 / denominator;
  const float k1 = p1 / denominator;
  const float error = measurement - (phi0 * theta[0] + phi1 * theta[1]);
  theta[0] += k0 * error;
  theta[1] += k1 * error;
  const float c00 = covariance[0][0];
  const float c01 = covariance[0][1];
  const float c10 = covariance[1][0];
  const float c11 = covariance[1][1];
  covariance[0][0] = (c00 - k0 * (phi0 * c00 + phi1 * c10)) / forgetting;
  covariance[0][1] = (c01 - k0 * (phi0 * c01 + phi1 * c11)) / forgetting;
  covariance[1][0] = (c10 - k1 * (phi0 * c00 + phi1 * c10)) / forgetting;
  covariance[1][1] = (c11 - k1 * (phi0 * c01 + phi1 * c11)) / forgetting;
}

static void updateMotorModel(float busV, float currentAmps, float velocityDps,
                             int16_t signedPwm) {
  if (!modelIdentificationEnabled || busV < 2.0f || abs(signedPwm) < 40) return;
  const uint32_t nowUs = micros();
  const float dt = modelPreviousSampleUs == 0 ? 0.0f :
                   static_cast<float>(nowUs - modelPreviousSampleUs) / 1000000.0f;
  modelPreviousSampleUs = nowUs;
  // All three values are already expressed in controller coordinates:
  // setModelPhase() maps positive controller torque through modelDirectionSign,
  // currentSensePolarity maps INA240 current back to the same sign, and the
  // encoder unwrap is the position coordinate. Applying modelDirectionSign a
  // second time corrupts one board's fit. The old code also discarded PWM
  // sign, so reverse samples tried to fit negative I/omega to positive volts.
  const float current = currentAmps;
  const float omega = velocityDps * 0.01745329252f;
  const float appliedVoltage = busV * static_cast<float>(signedPwm) /
                               static_cast<float>(PWM_MAX);
  if (fabsf(current) > 0.03f || fabsf(omega) > 5.0f) {
    rlsUpdate2(electricalTheta, electricalCovariance, current, omega, appliedVoltage);
    modelResistanceOhm = constrain(electricalTheta[0], 0.05f, 20.0f);
    modelKeVoltSecondsPerRad = constrain(electricalTheta[1], 0.0001f, 0.2f);
    electricalTheta[0] = modelResistanceOhm;
    electricalTheta[1] = modelKeVoltSecondsPerRad;
    if (++modelElectricalSamples > 20) modelHasElectricalFit = true;
  }
  if (dt > 0.0002f && dt < 0.1f && modelElectricalSamples > 20) {
    const float acceleration = (omega - modelPreviousVelocityRadPerSecond) / dt;
    if (fabsf(acceleration) < 200000.0f && fabsf(omega) < 2500.0f) {
      // alpha = (Kt/J) * I - (B/J) * omega. The two fitted ratios are the
      // mechanical parameters needed by the model-based velocity loop.
      rlsUpdate2(mechanicalTheta, mechanicalCovariance, current, -omega, acceleration);
      mechanicalTheta[0] = constrain(mechanicalTheta[0], 1.0f, 200000.0f);
      mechanicalTheta[1] = constrain(mechanicalTheta[1], 0.0f, 100.0f);
      if (++modelMechanicalSamples > 50) modelHasMechanicalFit = true;
    }
  }
  modelPreviousVelocityRadPerSecond = omega;
}

static const char *controlModeName() {
  switch (controlMode) {
    case CONTROL_CURRENT: return "current";
    case CONTROL_VELOCITY: return "velocity";
    case CONTROL_POSITION: return "position";
    case CONTROL_IDENTIFY: return "identify";
    default: return "idle";
  }
}

static float modelTargetForTelemetry() {
  if (controlMode == CONTROL_POSITION) return modelTargetPositionDegrees;
  if (controlMode == CONTROL_VELOCITY) return modelTargetVelocityDps;
  if (controlMode == CONTROL_CURRENT) return modelTargetCurrentAmps * 1000.0f;
  return 0.0f;
}

static void setCurrentStep(uint8_t step) {
  step = min<uint8_t>(step, 3);
  digitalWrite(PIN_I0, step & 1 ? HIGH : LOW);
  digitalWrite(PIN_I1, step & 2 ? HIGH : LOW);
  currentStep = step;
}

static void modelControlTick() {
  if (!modelControlActive || !driverAwake) return;
  const uint32_t now = millis();
  if (modelStopAtMs != 0 && static_cast<int32_t>(now - modelStopAtMs) >= 0) {
    motorStop();
    Console.println("MODEL timeout");
    return;
  }
  if (now - lastModelTickMs < 1) return;
  const float dt = lastModelTickMs == 0 ? 0.001f :
                   static_cast<float>(max<uint32_t>(1, now - lastModelTickMs)) / 1000.0f;
  lastModelTickMs = now;
  if (digitalRead(PIN_NFAULT) == LOW) {
    motorStop();
    Console.println("MODEL fault nFAULT=0");
    return;
  }
  uint16_t raw = 0;
  float singleDegrees = 0.0f;
  if (!readEncoder(raw, singleDegrees)) return;
  float busAdcMv = 0.0f;
  const float busV = readBusVoltage(&busAdcMv);
  if (busV < 2.0f) {
    motorStop();
    Console.printf("MODEL bus_low=%.2fV\n", busV);
    return;
  }
  const float currentRawMv = readCurrentSenseMillivolts();
  const float currentMv = filterCurrentSenseMillivolts(currentRawMv);
  const float currentAmps = readSignedCurrentMilliamps(currentMv) / 1000.0f;
  latestCurrentMilliamps = currentAmps * 1000.0f;
  const float measuredVelocityDps = encoderVelocityDegreesPerSecond;
  updateMotorModel(busV, currentAmps, measuredVelocityDps,
                   commandedSignedPwmDuty);

  float velocityTargetDps = modelTargetVelocityDps;
  float positionError = 0.0f;
  if (controlMode == CONTROL_POSITION) {
    positionError = modelTargetPositionDegrees - encoderMultiTurnDegrees;
    if (positionPidEnabled) {
      const float settleRearmError = positionPidDeadbandDeg + 4.0f;
      if (positionPidSettled && fabsf(positionError) > settleRearmError) {
        positionPidSettled = false;
      }
      if (!positionPidSettled && fabsf(positionError) <= positionPidDeadbandDeg &&
          fabsf(measuredVelocityDps) < 120.0f) {
        positionPidSettled = true;
      }
      const float pidError = (positionPidSettled ||
                              fabsf(positionError) <= positionPidDeadbandDeg)
                               ? 0.0f : positionError;
      const float pidLimit = min(static_cast<float>(modelMaxDuty), positionPidMaxPwm);
      float pwmOutput = 0.0f;
      if (pidError == 0.0f) {
        // A deadband must be a real no-drive band. Previously the D term was
        // still evaluated here, then a tiny derivative output was raised to
        // minPWM and caused continuous direction reversals around the target.
        positionPidIntegral = 0.0f;
      } else {
        const float candidateIntegral = constrain(
            positionPidIntegral + pidError * dt,
            -positionPidIntegralLimit, positionPidIntegralLimit);
        const float candidateOutput = positionPidKp * pidError +
                                      positionPidKi * candidateIntegral -
                                      positionPidKd * measuredVelocityDps;
        const bool saturatedWithError =
            (candidateOutput > pidLimit && pidError > 0.0f) ||
            (candidateOutput < -pidLimit && pidError < 0.0f);
        // Conditional integration is the anti-windup term: do not keep
        // accumulating in the direction that is already output-saturated.
        if (!saturatedWithError || pidError * candidateOutput < 0.0f) {
          positionPidIntegral = candidateIntegral;
        }
        pwmOutput = constrain(
            positionPidKp * pidError + positionPidKi * positionPidIntegral -
                positionPidKd * measuredVelocityDps,
            -pidLimit, pidLimit);
      }
      // Position PID is deliberately a direct signed-PWM controller. With
      // Ki=Kd=0 the raw value is exactly Kp*(target-measured_multi_turn).
      // Apply a continuous, explicit stiction floor outside the deadband.
      // The previous one-control-tick sigma-delta pulses were too short to
      // break a 775 rotor free and made both PWM and current plots chatter.
      latestPositionPidRawPwm = pwmOutput;
      if (fabsf(pwmOutput) < 0.5f) {
        positionPidPulseAccumulator = 0.0f;
        positionPidSlewedPwm = 0.0f;
        positionPidStallBoostPwm = 0.0f;
        setPwm(0);
      } else {
        const float requestedMagnitude = fabsf(pwmOutput);
        if (fabsf(measuredVelocityDps) < 35.0f) {
          positionPidStallBoostPwm = min(POSITION_STALL_BOOST_MAX,
              positionPidStallBoostPwm + POSITION_STALL_BOOST_PER_SECOND * dt);
        } else {
          positionPidStallBoostPwm = max(0.0f,
              positionPidStallBoostPwm - POSITION_STALL_BOOST_DECAY_PER_SECOND * dt);
        }
        const float minPwm = min(positionPidMinPwm + positionPidStallBoostPwm,
                                 pidLimit);
        positionPidPulseAccumulator = 0.0f;
        const float desiredPwm = copysignf(
            max(requestedMagnitude, minPwm), pwmOutput);
        const float maxDelta = POSITION_PWM_SLEW_PER_SECOND * dt;
        positionPidSlewedPwm = constrain(desiredPwm,
                                         positionPidSlewedPwm - maxDelta,
                                         positionPidSlewedPwm + maxDelta);
        if (fabsf(positionPidSlewedPwm) < 0.5f) {
          setPwm(0);
        } else {
          setModelPhase(positionPidSlewedPwm > 0.0f ? 1.0f : -1.0f);
          setPwm(static_cast<uint16_t>(fabsf(positionPidSlewedPwm)));
        }
      }
      latestPositionPidAppliedPwm = positionPidSlewedPwm;
      if (now - lastPositionDebugMs >= 100) {
        lastPositionDebugMs = now;
        Console.printf("POSITION_PID target=%.2f multi=%.2f error=%.2f kp=%.4f ki=%.4f kd=%.4f raw_pwm=%.1f applied_pwm=%.1f/%u\n",
                      modelTargetPositionDegrees, encoderMultiTurnDegrees,
                      positionError, positionPidKp, positionPidKi,
                      positionPidKd, pwmOutput, positionPidSlewedPwm,
                      static_cast<unsigned>(modelMaxDuty));
      }
      return;
    } else {
      const float direction = positionError >= 0.0f ? 1.0f : -1.0f;
      const float proportionalSpeed = fabsf(positionError) * POSITION_PROFILE_KP_DPS_PER_DEG;
      const float brakingSpeed = sqrtf(max(0.0f, 2.0f * POSITION_PROFILE_ACCEL_DPS2 * fabsf(positionError)));
      velocityTargetDps = direction * min(modelMaxVelocityDps,
                                          min(POSITION_PROFILE_MAX_DPS,
                                              min(proportionalSpeed, brakingSpeed)));
    }
    if (!syncControlRunning && !positionPidEnabled && fabsf(positionError) < 0.25f &&
        fabsf(measuredVelocityDps) < 60.0f) {
      modelControlActive = false;
      controlMode = CONTROL_IDLE;
      setPwm(0);
      Console.printf("MODEL position_reached multi=%.2f target=%.2f\n",
                    encoderMultiTurnDegrees, modelTargetPositionDegrees);
      return;
    }
  }

  float currentTargetAmps = modelTargetCurrentAmps;
  const bool startBoostActive = (controlMode == CONTROL_VELOCITY || controlMode == CONTROL_POSITION) &&
                                static_cast<int32_t>(now - modelStartBoostUntilMs) < 0;
  if (controlMode == CONTROL_VELOCITY || controlMode == CONTROL_POSITION) {
    const float velocityError = velocityTargetDps - measuredVelocityDps;
    // The mechanical model is identified in SI units (rad/s² per ampere),
    // while the UI/telemetry velocity is deg/s. Convert the commanded
    // acceleration before using the identified mechanical coefficient;
    // mixing deg/s² and rad/s² here would make the model current 57.3x too
    // small and is the main reason a position command could appear inert.
    const float accelerationCommandDps2 = constrain(velocityError * 18.0f,
                                                     -modelMaxAccelerationDps2,
                                                     modelMaxAccelerationDps2);
    const float accelerationCommand = accelerationCommandDps2 * 0.01745329252f;
    const float accelPerAmp = modelHasMechanicalFit ? mechanicalTheta[0] : 50000.0f;
    const float frictionAccel = modelHasMechanicalFit ? mechanicalTheta[1] : 0.5f;
    currentTargetAmps = (accelerationCommand + frictionAccel * velocityTargetDps * 0.01745329252f) /
                        max(100.0f, accelPerAmp);
    // The model provides the feed-forward current. This small bounded residual
    // term compensates load changes without turning the loop into blind PID.
    modelVelocityIntegral = constrain(modelVelocityIntegral + velocityError * dt, -3000.0f, 3000.0f);
    currentTargetAmps += modelVelocityIntegral * 0.00003f;
    // A 775 rotor has a static-friction/stiction threshold. The model
    // feed-forward term can legitimately be below it at low acceleration;
    // use a bounded starting-current term so a valid command does not result
    // in a few-milliamps PWM impulse that never moves the rotor.
    const bool allowPositionStartFloor = controlMode == CONTROL_POSITION &&
                                         fabsf(positionError) > 12.0f;
    const bool allowLowSpeedFloor = controlMode == CONTROL_VELOCITY || allowPositionStartFloor;
    const float breakawayCurrent = controlMode == CONTROL_VELOCITY
                                       ? (startBoostActive
                                              ? MODEL_START_CURRENT_A
                                              : constrain(fabsf(velocityTargetDps) * 0.0008f,
                                                          0.08f, MODEL_START_CURRENT_A))
                                       : MODEL_START_CURRENT_A;
    if (fabsf(velocityTargetDps) > 20.0f && fabsf(currentTargetAmps) < breakawayCurrent &&
        (startBoostActive || (allowLowSpeedFloor && fabsf(measuredVelocityDps) < 100.0f))) {
      currentTargetAmps = copysignf(breakawayCurrent, velocityTargetDps);
    }
  }
  currentTargetAmps = constrain(currentTargetAmps, -modelCurrentLimitAmps, modelCurrentLimitAmps);
  if (fabsf(currentTargetAmps) < 0.01f && fabsf(velocityTargetDps) < 1.0f) {
    modelCurrentIntegral = 0.0f;
    setPwm(0);
    return;
  }
  float commandDirection = currentTargetAmps >= 0.0f ? 1.0f : -1.0f;
  if (fabsf(currentTargetAmps) < 0.02f && fabsf(velocityTargetDps) > 1.0f) {
    commandDirection = velocityTargetDps >= 0.0f ? 1.0f : -1.0f;
  }
  setModelPhase(commandDirection);
  const float measuredCurrentInCommandDirection = currentAmps * commandDirection;
  const float targetCurrentMagnitude = fabsf(currentTargetAmps);
  const float currentError = targetCurrentMagnitude - measuredCurrentInCommandDirection;
  modelCurrentIntegral = constrain(modelCurrentIntegral + currentError * dt, -2.0f, 2.0f);
  const float omegaTarget = velocityTargetDps * 0.01745329252f;
  const float feedforwardVoltage = modelResistanceOhm * targetCurrentMagnitude +
                                   modelKeVoltSecondsPerRad * fabsf(omegaTarget);
  const float dutyFeedforward = feedforwardVoltage / busV * static_cast<float>(PWM_MAX);
  const float currentKpDutyPerAmp = max(12.0f, modelResistanceOhm * static_cast<float>(PWM_MAX) / busV);
  const float currentKiDutyPerAmpSecond = currentKpDutyPerAmp * 30.0f;
  const float outputVelocityError = velocityTargetDps - measuredVelocityDps;
  const bool speedLoop = controlMode == CONTROL_VELOCITY || controlMode == CONTROL_POSITION;
  // The identified model produces a target current for the speed/position
  // loop. Close the inner current loop here instead of adding speed error
  // directly as PWM; direct speed-error PWM caused a low-speed command to
  // drive several amperes while the target current was only a few hundred
  // milliamperes.
  const float currentLoopDuty = dutyFeedforward + currentKpDutyPerAmp * currentError +
                                 currentKiDutyPerAmpSecond * modelCurrentIntegral;
  const float dutyCommand = speedLoop ? max(0.0f, currentLoopDuty) : currentLoopDuty;
  float currentLimitedDutyCommand = dutyCommand;
  if (speedLoop && measuredCurrentInCommandDirection > modelCurrentLimitAmps) {
    // Keep the model feed-forward path, but do not let a stalled rotor turn a
    // breakaway pulse into an unbounded branch-current command.
    currentLimitedDutyCommand *= modelCurrentLimitAmps /
                                 max(modelCurrentLimitAmps, measuredCurrentInCommandDirection);
  }
  const uint16_t duty = static_cast<uint16_t>(constrain(currentLimitedDutyCommand, 0.0f,
                                                        static_cast<float>(modelMaxDuty)));
  const bool lowSpeedAssist = (controlMode == CONTROL_VELOCITY || controlMode == CONTROL_POSITION) &&
                               fabsf(velocityTargetDps) > 20.0f && fabsf(outputVelocityError) > 50.0f &&
                               fabsf(measuredVelocityDps) < 35.0f &&
                               ((velocityTargetDps > 0.0f && outputVelocityError > 0.0f) ||
                               (velocityTargetDps < 0.0f && outputVelocityError < 0.0f));
  // Near the final position the identified model quite correctly asks for a
  // very small voltage, but a 775 rotor still needs a short static-friction
  // breakaway pulse. Pulse only in the final 0.25..4 degree window and only
  // while the measured speed is low, so this does not turn into an open-loop
  // full-power shove or disturb the normal speed loop.
  const bool positionFineApproach = controlMode == CONTROL_POSITION &&
                                    fabsf(positionError) > 0.25f &&
                                    fabsf(positionError) < 12.0f &&
                                    fabsf(measuredVelocityDps) < 80.0f;
  const bool positionFinePulse = positionFineApproach && (now % 50u < 8u);
  const uint16_t modelAssistDuty = static_cast<uint16_t>(constrain(
      ceilf(max(0.0f, dutyFeedforward)), 0.0f, static_cast<float>(modelMaxDuty)));
  const uint16_t assistDuty = max<uint16_t>(MODEL_START_DUTY, modelAssistDuty);
  // A fixed 180-count breakaway pulse is excessive for a low speed target.
  // Scale only the bounded startup assist with the requested speed; the
  // user's normal PWM ceiling remains the full 0..4095 range.
  const uint16_t velocityAssistDuty = min<uint16_t>(
      assistDuty, max<uint16_t>(24, static_cast<uint16_t>(fabsf(velocityTargetDps) * 0.08f)));
  const uint16_t startupAssistDuty = controlMode == CONTROL_POSITION
                                         ? assistDuty
                                         : velocityAssistDuty;
  const uint16_t fineAssistDuty = min<uint16_t>(
      assistDuty, max<uint16_t>(20, static_cast<uint16_t>(fabsf(positionError) * 18.0f)));
  // If the identified current is below the static-friction threshold and the
  // measured speed is still near zero, apply a short periodic breakaway
  // pulse. Once the rotor moves, the pulse disappears and the model current
  // loop is the only actuator again.
  const bool breakawayPulse = lowSpeedAssist && (now % 100u < 8u);
  const uint16_t pulseAssistDuty = breakawayPulse ? assistDuty : startupAssistDuty;
  const uint16_t normalDuty = (startBoostActive || breakawayPulse) && duty > 0
                                   ? max<uint16_t>(pulseAssistDuty, duty)
                                   : duty;
  uint16_t outputDuty = positionFineApproach
                          ? (positionFinePulse ? max<uint16_t>(fineAssistDuty, duty) : 0)
                          : normalDuty;
  if (speedLoop && measuredCurrentInCommandDirection > modelCurrentLimitAmps) {
    outputDuty = min<uint16_t>(outputDuty, duty);
  }
  setPwm(outputDuty);
  if (now - lastPositionDebugMs >= 100) {
    lastPositionDebugMs = now;
    Console.printf("MODEL mode=%s multi=%.2f target=%.2f vel=%.1f target_vel=%.1f current=%.3f target_current=%.3f duty=%u R=%.3f Ke=%.5f\n",
                  controlModeName(), encoderMultiTurnDegrees,
                  controlMode == CONTROL_POSITION ? modelTargetPositionDegrees : modelTargetVelocityDps,
                  measuredVelocityDps, velocityTargetDps, currentAmps, currentTargetAmps,
                  static_cast<unsigned>(duty), modelResistanceOhm, modelKeVoltSecondsPerRad);
  }
}

static void resetCascadeController() {
  cascadeVelocityRequestedDps = 0.0f;
  cascadeVelocityCommandDps = 0.0f;
  cascadeCurrentCommandA = 0.0f;
  cascadeSignedPwm = 0.0f;
  cascadePositionIntegral = 0.0f;
  cascadeVelocityIntegral = 0.0f;
  cascadeCurrentIntegral = 0.0f;
  cascadeVelocityBreakawayA = 0.0f;
  cascadeVelocityStictionActive = false;
  cascadeTrajectoryPositionDeg = encoderMultiTurnDegrees;
  cascadeTrajectoryVelocityDps = encoderVelocityDegreesPerSecond;
  cascadeTrajectoryAccelerationDps2 = 0.0f;
  cascadeBreakawayFeedForwardA = 0.0f;
  cascadeBreakawayPulseActive = false;
  cascadeBreakawayPulseUntilUs = 0;
  cascadeBreakawayLastAttemptUs = 0;
  cascadeBreakawayPulseReleasePending = false;
  cascadeBreakawayStartPositionDeg = encoderMultiTurnDegrees;
  cascadeBreakawayDirectionSign = 1;
  cascadePositionReleased = false;
  cascadeLastCurrentUs = 0;
  cascadeLastVelocityUs = 0;
  cascadeLastPositionUs = 0;
  cascadePositionSettled = false;
}

static void updateCascadePositionTrajectory(float dt) {
  const float maxVelocity = max(1.0f, cascadePositionMaxVelocityDps);
  const float maxAcceleration = max(1.0f, cascadePositionMaxAccelerationDps2);
  const float maxJerk = max(10.0f, cascadePositionMaxJerkDps3);
  const float bandwidth = constrain(cascadeTrajectoryBandwidthRadS,
                                    0.2f, 20.0f);
  const float distance = modelTargetPositionDegrees -
                         cascadeTrajectoryPositionDeg;

  if (fabsf(distance) <= 0.001f &&
      fabsf(cascadeTrajectoryVelocityDps) <= 0.05f) {
    cascadeTrajectoryPositionDeg = modelTargetPositionDegrees;
    cascadeTrajectoryVelocityDps = 0.0f;
    cascadeTrajectoryAccelerationDps2 = 0.0f;
    return;
  }

  // Critically damped reference governor. It approaches the target without
  // reference overshoot, accepts live retargets without resetting velocity,
  // and is bounded by velocity, acceleration, and jerk limits.
  const float desiredAcceleration = constrain(
      bandwidth * bandwidth * distance -
          2.0f * bandwidth * cascadeTrajectoryVelocityDps,
      -maxAcceleration, maxAcceleration);
  const float jerkStep = maxJerk * dt;
  cascadeTrajectoryAccelerationDps2 += constrain(
      desiredAcceleration - cascadeTrajectoryAccelerationDps2,
      -jerkStep, jerkStep);
  cascadeTrajectoryAccelerationDps2 = constrain(
      cascadeTrajectoryAccelerationDps2, -maxAcceleration, maxAcceleration);

  cascadeTrajectoryVelocityDps += cascadeTrajectoryAccelerationDps2 * dt;
  cascadeTrajectoryVelocityDps = constrain(cascadeTrajectoryVelocityDps,
      -maxVelocity, maxVelocity);
  cascadeTrajectoryPositionDeg += cascadeTrajectoryVelocityDps * dt;
}

static void cascadeControlTick() {
  if (powerPathFaultLatched) {
    if (modelControlActive || pwmDuty() != 0) motorStop();
    return;
  }
  if (!modelControlActive || !driverAwake) return;
  const uint32_t nowUs = micros();
  const uint32_t nowMs = millis();
  if (modelStopAtMs != 0 && static_cast<int32_t>(nowMs - modelStopAtMs) >= 0) {
    motorStop();
    Console.println("CASCADE timeout");
    return;
  }
  if (digitalRead(PIN_NFAULT) == LOW) {
    motorStop();
    Console.println("CASCADE fault nFAULT=0");
    return;
  }

  // Keep the final target visible in telemetry while releasing the actuator
  // near the target. A new POS command clears this flag and re-arms control.
  // The encoder still runs in this state: releasing torque must not freeze the
  // position shown in the web UI if the shaft settles into a nearby detent.
  if (controlMode == CONTROL_POSITION && cascadePositionReleased) {
    if (cascadeLastVelocityUs == 0 ||
        nowUs - cascadeLastVelocityUs >= POSITION_VELOCITY_LOOP_PERIOD_US) {
      cascadeLastVelocityUs = nowUs;
      uint16_t raw = 0;
      float singleDegrees = 0.0f;
      readEncoder(raw, singleDegrees);
      if (cascadeLastPositionUs == 0 ||
          nowUs - cascadeLastPositionUs >= POSITION_LOOP_PERIOD_US) {
        cascadeLastPositionUs = nowUs;
        cascadeBusVoltage = readBusVoltage();
      }
    }
    cascadeVelocityRequestedDps = 0.0f;
    cascadeVelocityCommandDps = 0.0f;
    cascadeCurrentCommandA = 0.0f;
    cascadeSignedPwm = 0.0f;
    cascadeMeasuredCurrentA = 0.0f;
    return;
  }

  // Position mode samples the encoder/velocity loop at 500 Hz so a direct
  // drive breakaway pulse can be detected and braked before it crosses a
  // full detent. Direct velocity mode retains the validated 200 Hz rate.
  const uint32_t velocityPeriodUs = controlMode == CONTROL_POSITION
      ? POSITION_VELOCITY_LOOP_PERIOD_US : VELOCITY_LOOP_PERIOD_US;
  if (cascadeLastVelocityUs == 0 ||
      nowUs - cascadeLastVelocityUs >= velocityPeriodUs) {
    const float velocityDt = cascadeLastVelocityUs == 0
        ? static_cast<float>(velocityPeriodUs) / 1000000.0f
        : static_cast<float>(nowUs - cascadeLastVelocityUs) / 1000000.0f;
    cascadeLastVelocityUs = nowUs;
    uint16_t raw = 0;
    float singleDegrees = 0.0f;
    if (!readEncoder(raw, singleDegrees)) return;

    if (cascadeLastPositionUs == 0 ||
        nowUs - cascadeLastPositionUs >= POSITION_LOOP_PERIOD_US) {
      const float positionDt = cascadeLastPositionUs == 0
          ? static_cast<float>(POSITION_LOOP_PERIOD_US) / 1000000.0f
          : static_cast<float>(nowUs - cascadeLastPositionUs) / 1000000.0f;
      cascadeLastPositionUs = nowUs;
      cascadeBusVoltage = readBusVoltage();
      if (cascadeBusVoltage < 2.0f) {
        motorStop();
        Console.printf("CASCADE bus_low=%.2fV\n", cascadeBusVoltage);
        return;
      }
      if (controlMode == CONTROL_POSITION) {
        const float finalError = modelTargetPositionDegrees -
                                 encoderMultiTurnDegrees;
        const float releaseWindow = max(0.35f, min(
            CASCADE_POSITION_RELEASE_WINDOW_DEG,
            max(1.0f, cascadePositionDeadbandDeg)));
        if (!cascadeBreakawayPulseActive &&
            fabsf(finalError) <= releaseWindow &&
            fabsf(encoderVelocityDegreesPerSecond) <=
                CASCADE_POSITION_RELEASE_SPEED_DPS &&
            fabsf(cascadeVelocityCommandDps) <=
                CASCADE_POSITION_RELEASE_COMMAND_DPS) {
          cascadePositionReleased = true;
          cascadePositionSettled = true;
          cascadeVelocityRequestedDps = 0.0f;
          cascadeVelocityCommandDps = 0.0f;
          cascadeCurrentCommandA = 0.0f;
          cascadeSignedPwm = 0.0f;
          cascadeMeasuredCurrentA = 0.0f;
          // In sign-magnitude mode PWM=0 disables ENBL. In locked-antiphase
          // mode explicitly disable ENBL once; do not re-enable the bridge on
          // every 500 Hz tick while the position command is released.
          if (lockedAntiphaseActive) disableBridgeOutput();
          else setPwm(0);
          Console.printf("CASCADE position_release multi=%.2f target=%.2f error=%.2f window=%.2f speed=%.1f\n",
                        encoderMultiTurnDegrees, modelTargetPositionDegrees,
                        finalError, releaseWindow,
                        encoderVelocityDegreesPerSecond);
          return;
        }
        if (cascadePositionSettled &&
            (fabsf(finalError) > cascadePositionDeadbandDeg + 0.25f ||
             fabsf(encoderVelocityDegreesPerSecond) > 5.0f)) {
          cascadePositionSettled = false;
        }
        if (!cascadePositionSettled &&
            fabsf(finalError) <= cascadePositionDeadbandDeg &&
            fabsf(encoderVelocityDegreesPerSecond) < 2.0f &&
            fabsf(cascadeTrajectoryVelocityDps) < 0.1f) {
          cascadePositionSettled = true;
        }
        // Integrate only near the final target. The trajectory reference owns
        // large moves; carrying a large approach integral into the hold phase
        // was one cause of the previous overshoot and target-to-target state
        // contamination.
        if (fabsf(finalError) < 5.0f &&
            fabsf(encoderVelocityDegreesPerSecond) < 30.0f) {
          cascadePositionIntegral = constrain(
              cascadePositionIntegral + finalError * positionDt,
              -50.0f, 50.0f);
        } else {
          cascadePositionIntegral *= max(0.0f, 1.0f - 4.0f * positionDt);
        }
        // Full-speed position profile. Far from the target the velocity loop
        // receives the configured maximum speed. Inside the physical braking
        // distance it follows v=sqrt(2*a*x), so a large move is no longer
        // limited to Kp*error yet still brakes before crossing the target.
        // At the 100 kdeg/s^2 default, 6000 deg/s is reached in 60 ms and the
        // deceleration phase starts about 180 degrees before the target.
        const float brakingDistance = max(0.0f,
            fabsf(finalError) - cascadePositionDeadbandDeg);
        const float brakingSpeed = sqrtf(2.0f *
            max(1.0f, cascadePositionMaxAccelerationDps2) * brakingDistance);
        float positionVelocityRequest = copysignf(
            min(cascadePositionMaxVelocityDps, brakingSpeed), finalError);
        if (brakingDistance <= 0.0f) positionVelocityRequest = 0.0f;
        cascadeVelocityRequestedDps = constrain(
            positionVelocityRequest,
            -cascadePositionMaxVelocityDps, cascadePositionMaxVelocityDps);
        // Keep the trajectory state available for diagnostics/retargeting,
        // but do not use its lagging position as feedback for the actuator.
        cascadeTrajectoryPositionDeg = encoderMultiTurnDegrees;
        cascadeTrajectoryVelocityDps = cascadeVelocityRequestedDps;
        cascadeTrajectoryAccelerationDps2 = 0.0f;
      } else if (controlMode == CONTROL_VELOCITY) {
        cascadeVelocityRequestedDps = modelTargetVelocityDps;
      }
    }

    if (controlMode == CONTROL_POSITION || controlMode == CONTROL_VELOCITY) {
      if (controlMode == CONTROL_POSITION) {
        // The position outer loop is a final-error PD law.  Slew its velocity
        // output with the identified acceleration envelope so a retarget or a
        // sign change cannot become an instantaneous torque reversal.
        const float velocityStep =
            max(1.0f, cascadePositionMaxAccelerationDps2) * velocityDt;
        cascadeVelocityCommandDps += constrain(
            cascadeVelocityRequestedDps - cascadeVelocityCommandDps,
            -velocityStep, velocityStep);
        if (fabsf(cascadeVelocityRequestedDps) < 0.01f &&
            fabsf(cascadeVelocityCommandDps) < velocityStep) {
          cascadeVelocityCommandDps = 0.0f;
        }
      } else {
        // Direct velocity commands retain a continuous acceleration ramp so a
        // slider retarget never falls to zero before rising toward the next
        // target.
        const float velocityStep =
            CASCADE_DIRECT_VELOCITY_ACCELERATION_DPS2 * velocityDt;
        cascadeVelocityCommandDps += constrain(
            cascadeVelocityRequestedDps - cascadeVelocityCommandDps,
            -velocityStep, velocityStep);
        if (fabsf(cascadeVelocityRequestedDps) < 0.01f &&
            fabsf(cascadeVelocityCommandDps) < velocityStep) {
          cascadeVelocityCommandDps = 0.0f;
        }
      }
      const float velocityError = cascadeVelocityCommandDps -
                                  encoderVelocityDegreesPerSecond;

      const float finalPositionError = controlMode == CONTROL_POSITION
          ? modelTargetPositionDegrees - encoderMultiTurnDegrees : 0.0f;
      const bool coarseDirectionalApproach =
          controlMode == CONTROL_POSITION &&
          fabsf(finalPositionError) >
              max(CASCADE_POSITION_DIRECTIONAL_APPROACH_WINDOW_DEG,
                  cascadePositionDeadbandDeg * 4.0f);
      const bool motionRequested = fabsf(cascadeVelocityCommandDps) > 0.05f &&
          (controlMode == CONTROL_VELOCITY ||
           fabsf(finalPositionError) > cascadePositionDeadbandDeg);
      // Use the filtered velocity for control decisions. The raw MT6701
      // delta is retained in telemetry, but a single quantisation step at
      // 500 Hz is already about 11 deg/s and must not start/release torque.
      const bool rotorStationary =
          fabsf(encoderVelocityDegreesPerSecond) < 8.0f;
      const bool lowSpeedPositionMove =
          controlMode == CONTROL_POSITION &&
          fabsf(finalPositionError) > max(0.25f, cascadePositionDeadbandDeg * 2.0f) &&
          fabsf(cascadeVelocityCommandDps) < 200.0f;
      // In position mode, a direct-drive 775 may need extra torque to leave a
      // magnetic detent. Do not apply a fixed high-current pulse: ramp the
      // current reference and terminate it as soon as real movement is seen.
      // The velocity/current loops then take over and brake/hold the shaft.
      const bool positionNeedsBreakaway = lowSpeedPositionMove &&
          fabsf(encoderVelocityDegreesPerSecond) < 8.0f;
      const bool breakawayCandidate = controlMode == CONTROL_POSITION &&
          motionRequested &&
          (rotorStationary || positionNeedsBreakaway);
      const uint32_t retryUs = static_cast<uint32_t>(
          max(1.0f, cascadeBreakawayRetryMs) * 1000.0f);
      const bool retryAllowed = cascadeBreakawayLastAttemptUs == 0 ||
          nowUs - cascadeBreakawayLastAttemptUs >= retryUs;
      bool pulseEndedThisTick = false;
      if (cascadeBreakawayPulseActive) {
        // MT6701 differentiation is quantised at the 500 Hz position sample
        // rate.  One isolated sample can be a whole-count spike, so do not
        // terminate the torque assist on a single velocity reading.  Require
        // either real same-direction displacement or several consecutive
        // same-direction speed samples.
        const float directedDisplacement =
            (encoderMultiTurnDegrees - cascadeBreakawayStartPositionDeg) *
            static_cast<float>(cascadeBreakawayDirectionSign);
        const bool velocityInDirection =
            encoderVelocityDegreesPerSecond *
                static_cast<float>(cascadeBreakawayDirectionSign) > 0.0f;
        const bool speedSample = velocityInDirection &&
            fabsf(encoderVelocityDegreesPerSecond) >=
                cascadeBreakawayPulseSpeedDps;
        if (speedSample) {
          cascadeBreakawayMotionTicks = min<uint8_t>(
              4, static_cast<uint8_t>(cascadeBreakawayMotionTicks + 1));
        } else {
          cascadeBreakawayMotionTicks = 0;
        }
        const bool movedBySpeed = cascadeBreakawayMotionTicks >= 4;
        const bool movedByDistance = directedDisplacement >= 4.0f;
        const bool pulseExpired = static_cast<int32_t>(
            nowUs - cascadeBreakawayPulseUntilUs) >= 0;
        const bool targetDirectionChanged =
            finalPositionError * static_cast<float>(
                cascadeBreakawayDirectionSign) < -cascadePositionDeadbandDeg;
        if (movedBySpeed || movedByDistance || pulseExpired ||
            targetDirectionChanged) {
          cascadeBreakawayPulseActive = false;
          cascadeBreakawayFeedForwardA = 0.0f;
          cascadeBreakawayPulseReleasePending = true;
          cascadeBreakawayMotionTicks = 0;
          pulseEndedThisTick = true;
        }
      }
      if (!cascadeBreakawayPulseActive && breakawayCandidate && retryAllowed) {
        const float pulseCurrent = min(fabsf(cascadeBreakawayPulseCurrentA),
                                       cascadeVelocityMaxCurrentA);
        cascadeBreakawayPulseActive = pulseCurrent >= 0.05f;
        if (cascadeBreakawayPulseActive) {
          cascadeBreakawayPulseUntilUs = nowUs + static_cast<uint32_t>(
              max(1.0f, cascadeBreakawayPulseMs) * 1000.0f);
          cascadeBreakawayLastAttemptUs = nowUs;
          cascadeBreakawayStartPositionDeg = encoderMultiTurnDegrees;
          cascadeBreakawayDirectionSign = finalPositionError >= 0.0f ? 1 : -1;
          cascadeBreakawayMotionTicks = 0;
          cascadeBreakawayFeedForwardA = 0.02f *
              static_cast<float>(cascadeBreakawayDirectionSign);
          // Do not carry a previous velocity integral into the impulse.
          cascadeVelocityIntegral = 0.0f;
        }
      }
      if (cascadeBreakawayPulseActive && !pulseEndedThisTick) {
        const float pulseCurrent = min(fabsf(cascadeBreakawayPulseCurrentA),
                                       cascadeVelocityMaxCurrentA);
        const float pulseStep = max(0.1f, cascadeBreakawayRampAps) *
                                velocityDt;
        cascadeBreakawayFeedForwardA += pulseStep *
            static_cast<float>(cascadeBreakawayDirectionSign);
        cascadeBreakawayFeedForwardA = constrain(
            cascadeBreakawayFeedForwardA,
            -pulseCurrent, pulseCurrent);
      } else if (!cascadeBreakawayPulseActive) {
        cascadeBreakawayFeedForwardA = 0.0f;
      }
      cascadeVelocityBreakawayA = cascadeBreakawayFeedForwardA;
      cascadeVelocityStictionActive =
          cascadeBreakawayPulseActive;

      // The configured friction current is only the measured breakaway kick.
      // Once moving, use the identified mechanical model instead of injecting
      // a constant current forever. For alpha=(Kt/J)I-(B/J)omega, the current
      // required to cancel running drag is (B/Kt)omega = theta1/theta0*omega.
      float runningFeedForwardA = 0.0f;
      if (modelHasMechanicalFit && mechanicalTheta[0] > 1.0f) {
        const float requestedOmega = cascadeVelocityCommandDps * 0.01745329252f;
        runningFeedForwardA = mechanicalTheta[1] / mechanicalTheta[0] *
                              requestedOmega;
        runningFeedForwardA = constrain(runningFeedForwardA,
            -cascadeVelocityFrictionA, cascadeVelocityFrictionA);
      }
      const float velocityFeedForward = runningFeedForwardA +
                                       cascadeBreakawayFeedForwardA;
      // The already-validated high-speed gains remain untouched. Below
      // 1000 deg/s the direct-drive 775 needs a stronger, continuous PI loop;
      // this schedule is shared by velocity and position modes so the outer
      // loop never switches to another actuator model near the target.
      const bool lowSpeedRequest = motionRequested &&
          fabsf(cascadeVelocityCommandDps) < 1000.0f;
      const float lowSpeedKpFloor = 0.0060f;
      const float effectiveVelocityKp = lowSpeedRequest
          ? max(cascadeVelocityKp, lowSpeedKpFloor) : cascadeVelocityKp;
      const float effectiveVelocityKi = lowSpeedRequest
          ? max(cascadeVelocityKi, 0.0010f) : cascadeVelocityKi;
      const float velocityIntegralLimit = effectiveVelocityKi > 0.0000001f
          ? cascadeVelocityMaxCurrentA / effectiveVelocityKi
          : 10000.0f;
      float candidateIntegral = constrain(
          cascadeVelocityIntegral + velocityError * velocityDt,
          -velocityIntegralLimit, velocityIntegralLimit);
      const float candidateCurrent = effectiveVelocityKp * velocityError +
                                     effectiveVelocityKi * candidateIntegral +
                                     velocityFeedForward;
      const bool saturated = (candidateCurrent > cascadeVelocityMaxCurrentA && velocityError > 0.0f) ||
                             (candidateCurrent < -cascadeVelocityMaxCurrentA && velocityError < 0.0f);
      // Build torque quickly for a real speed step, then soften only the last
      // part of the approach. This removes the old 150-200 ms artificial
      // delay at a 1.5-2 A request without turning encoder quantisation near
      // the target into audible current chatter.
      const float configuredCurrentSlewAps =
          max(0.1f, cascadeVelocityCurrentSlewAps);
      const float quietCurrentSlewAps = min(
          configuredCurrentSlewAps,
          CASCADE_VELOCITY_QUIET_CURRENT_SLEW_A_PER_S);
      const float responseBlend = constrain(
          fabsf(velocityError) / CASCADE_VELOCITY_FULL_RESPONSE_ERROR_DPS,
          0.0f, 1.0f);
      const float currentBuildSlewAps = quietCurrentSlewAps +
          (configuredCurrentSlewAps - quietCurrentSlewAps) * responseBlend;
      const float baseCurrentStepA = currentBuildSlewAps * velocityDt;
      const float currentBeforeIntegralA = constrain(
          effectiveVelocityKp * velocityError +
              effectiveVelocityKi * cascadeVelocityIntegral +
              velocityFeedForward,
          -cascadeVelocityMaxCurrentA, cascadeVelocityMaxCurrentA);
      const bool currentSlewLagging =
          fabsf(currentBeforeIntegralA - cascadeCurrentCommandA) >
          baseCurrentStepA * 2.0f;
      const bool integralUnwinding =
          cascadeVelocityIntegral * velocityError < 0.0f;
      // Tracking anti-windup: do not store extra velocity error while the
      // torque command itself is still slewing toward the previous request.
      // Always permit opposite-sign error to unwind an existing integral.
      if (!saturated && (!currentSlewLagging || integralUnwinding)) {
        cascadeVelocityIntegral = candidateIntegral;
      }
      float requestedCurrentA = constrain(
          effectiveVelocityKp * velocityError +
              effectiveVelocityKi * cascadeVelocityIntegral +
              velocityFeedForward,
          -cascadeVelocityMaxCurrentA, cascadeVelocityMaxCurrentA);
      // Static friction compensation is a continuous, identified feed-forward
      // term, not another PID gain.  At zero speed the 775 needs the measured
      // breakaway current to leave a magnetic detent; once the shaft is moving
      // that term must fade smoothly or it becomes the source of overshoot.
      // Gate it by the velocity error so it cannot fight the inner loop while
      // the rotor is already faster than the requested trajectory.
      const bool positionNeedsForwardTorque =
          controlMode == CONTROL_POSITION &&
          finalPositionError * cascadeVelocityCommandDps >
              cascadePositionDeadbandDeg &&
          velocityError * cascadeVelocityCommandDps > 0.0f &&
          fabsf(encoderVelocityDegreesPerSecond) < 120.0f;
      if (positionNeedsForwardTorque && cascadeVelocityFrictionA > 0.0f) {
        const float speedBlend = constrain(
            1.0f - fabsf(encoderVelocityDegreesPerSecond) / 120.0f,
            0.0f, 1.0f);
        const float staticAssistA = cascadeVelocityFrictionA *
                                    speedBlend * speedBlend;
        requestedCurrentA = constrain(
            requestedCurrentA + copysignf(staticAssistA,
                                          cascadeVelocityCommandDps),
            -cascadeVelocityMaxCurrentA, cascadeVelocityMaxCurrentA);
      }
      // At low speed the identified static-friction term may still be
      // cancelled by a small velocity-loop request.  Keep a configurable
      // minimum torque reference while the position error and velocity error
      // both ask for forward motion.  It is deliberately not active while
      // braking, reversing, or holding inside the final 0.25 degree window.
      // The current-loop and max-current limit remain authoritative.
      const bool lowSpeedPositionTorque =
          controlMode == CONTROL_POSITION &&
          !coarseDirectionalApproach &&
          fabsf(finalPositionError) > max(0.25f,
                                          cascadePositionDeadbandDeg * 2.0f) &&
          finalPositionError * cascadeVelocityCommandDps >
              cascadePositionDeadbandDeg &&
          velocityError * cascadeVelocityCommandDps > 0.0f &&
          fabsf(encoderVelocityDegreesPerSecond) < 12.0f;
      if (lowSpeedPositionTorque && cascadePositionLowSpeedCurrentA > 0.0f) {
        const float minimumCurrentA = min(cascadePositionLowSpeedCurrentA,
                                          cascadeVelocityMaxCurrentA);
        requestedCurrentA = copysignf(
            max(fabsf(requestedCurrentA), minimumCurrentA),
            cascadeVelocityCommandDps);
      }
      if (cascadeBreakawayPulseActive) {
        // The pulse is a current reference, not a PWM bypass. Let the 2 kHz
        // current loop shape the bridge voltage, but do not let the velocity
        // PI subtract most of the short breakaway impulse.
        requestedCurrentA = cascadeBreakawayFeedForwardA;
      }
      // Far from the target, the position error chooses the travel direction.
      // Do not apply a reverse torque just because the quantised velocity
      // estimate briefly exceeds the requested speed; coast until the speed
      // falls back below the target. Signed braking is retained in the final
      // approach window, where it is needed to catch the target.
      if (coarseDirectionalApproach &&
          requestedCurrentA * finalPositionError < 0.0f) {
        requestedCurrentA = 0.0f;
        cascadeVelocityIntegral *= max(0.0f, 1.0f - 8.0f * velocityDt);
      }
      // Limit torque-command slew. Current regulation still runs at 2 kHz;
      // this 200 Hz limiter only prevents the outer loop from commanding an
      // instantaneous multi-ampere reversal on a light rotor.
      const bool currentReversing =
          requestedCurrentA * cascadeCurrentCommandA < 0.0f;
      const bool currentReducing =
          fabsf(requestedCurrentA) + 0.01f < fabsf(cascadeCurrentCommandA);
      // Release or reverse torque faster than it is built. This retains a
      // soft launch without allowing a positive current ramp to coast through
      // the target for seconds before braking becomes available.
      const float slewMultiplier =
          (currentReversing || currentReducing)
              ? cascadeVelocityBrakeSlewMultiplier : 1.0f;
      const float currentStepA = baseCurrentStepA * slewMultiplier;
      if (cascadeBreakawayPulseActive) {
        // A bounded pulse must reach its configured current promptly; the
        // inner current regulator remains the only actuator that converts it
        // into PWM.
        cascadeCurrentCommandA = requestedCurrentA;
      } else {
        const float releaseStepA = cascadeBreakawayPulseReleasePending
            ? max(currentStepA, max(1.0f, fabsf(cascadeCurrentCommandA)))
            : currentStepA;
        cascadeCurrentCommandA += constrain(
            requestedCurrentA - cascadeCurrentCommandA,
            -releaseStepA, releaseStepA);
        if (fabsf(requestedCurrentA) < 0.001f &&
            fabsf(cascadeCurrentCommandA) < releaseStepA) {
          cascadeCurrentCommandA = 0.0f;
        }
        cascadeBreakawayPulseReleasePending = false;
      }
    } else if (controlMode == CONTROL_CURRENT) {
      cascadeCurrentCommandA = modelTargetCurrentAmps;
    }
  }

  if (cascadeLastCurrentUs != 0 &&
      nowUs - cascadeLastCurrentUs < CURRENT_LOOP_PERIOD_US) return;
  const float currentDt = cascadeLastCurrentUs == 0
      ? static_cast<float>(CURRENT_LOOP_PERIOD_US) / 1000000.0f
      : static_cast<float>(nowUs - cascadeLastCurrentUs) / 1000000.0f;
  cascadeLastCurrentUs = nowUs;
  const float currentMv = filterCurrentSenseMillivolts(readCurrentSenseMillivolts());
  cascadeMeasuredCurrentA = readSignedCurrentMilliamps(currentMv) / 1000.0f;
  latestCurrentMilliamps = cascadeMeasuredCurrentA * 1000.0f;
  if (cascadeBusVoltage < 2.0f) cascadeBusVoltage = readBusVoltage();

  const float currentTarget = constrain(cascadeCurrentCommandA,
                                        -modelCurrentLimitAmps,
                                        modelCurrentLimitAmps);
  // A zero current reference means high impedance/coast for this sign-
  // magnitude bridge. Do not use a reverse voltage pulse to cancel the
  // measured current left by a just-finished breakaway pulse; that pulse was
  // the reason a nominally positive 2 deg move first jumped negative.
  // Explicit opposite-sign current from the velocity/position loop still
  // reaches the current regulator and is allowed to brake the rotor.
  if (fabsf(currentTarget) < 0.005f) {
    cascadeCurrentIntegral = 0.0f;
    cascadeSignedPwm = 0.0f;
    applyCascadeBridgePwm(0.0f);
    return;
  }
  // The SS6952T path is a sign-magnitude bridge.  When the requested torque
  // changes sign while the motor branch still carries current in the old
  // direction, applying the opposite PWM immediately creates a large reverse
  // current impulse.  On this very light, unloaded 775 that impulse is enough
  // to jump across several encoder detents and is the source of the observed
  // position chatter.  Let the branch current decay with zero PWM first;
  // once it is near zero, the normal signed current PI takes over.  This is a
  // bumpless sign transition, not a reduction of the normal 0..4095 duty
  // range or of the configured current limit.
  if (cascadeMeasuredCurrentA * currentTarget < 0.0f &&
      fabsf(cascadeMeasuredCurrentA) > 0.08f) {
    cascadeCurrentIntegral = 0.0f;
    cascadeSignedPwm = 0.0f;
    applyCascadeBridgePwm(0.0f);
    return;
  }
  const float currentError = currentTarget - cascadeMeasuredCurrentA;
  const float candidateIntegral = constrain(
      cascadeCurrentIntegral + currentError * currentDt, -5.0f, 5.0f);
  const float omega = encoderVelocityDegreesPerSecond * 0.01745329252f;
  const float feedforwardVoltage = modelResistanceOhm * currentTarget +
                                   modelKeVoltSecondsPerRad * omega;
  const float feedforwardPwm = feedforwardVoltage /
                               max(2.0f, cascadeBusVoltage) * PWM_MAX;
  const float candidatePwm = feedforwardPwm + cascadeCurrentKp * currentError +
                             cascadeCurrentKi * candidateIntegral;
  const float pwmLimit = min(static_cast<float>(modelMaxDuty),
                             cascadeCurrentMaxPwm);
  const bool saturated = (candidatePwm > pwmLimit && currentError > 0.0f) ||
                         (candidatePwm < -pwmLimit && currentError < 0.0f);
  if (!saturated) cascadeCurrentIntegral = candidateIntegral;
  float requestedPwm =
      feedforwardPwm + cascadeCurrentKp * currentError +
          cascadeCurrentKi * cascadeCurrentIntegral;
  cascadeSignedPwm = constrain(requestedPwm, -pwmLimit, pwmLimit);
  applyCascadeBridgePwm(cascadeSignedPwm);
  // A successful USB command is not proof that the power stage is working.
  // In direct-current commissioning mode, full bridge demand with no branch
  // current and no shaft motion indicates an open motor lead, disabled output
  // path, or invalid current feedback. Never leave 100% PWM applied in that
  // state: stop locally even if the browser or USB link disappears.
  const bool noCurrentResponse = controlMode != CONTROL_IDLE &&
      fabsf(currentTarget) >= 0.50f &&
      fabsf(cascadeSignedPwm) >= pwmLimit * 0.90f &&
      fabsf(cascadeMeasuredCurrentA) < max(0.08f, fabsf(currentTarget) * 0.08f) &&
      fabsf(encoderVelocityDegreesPerSecond) < 5.0f;
  if (noCurrentResponse) {
    if (cascadeNoCurrentResponseSinceMs == 0) {
      cascadeNoCurrentResponseSinceMs = nowMs;
    } else if (nowMs - cascadeNoCurrentResponseSinceMs >= 350) {
      const float failedTarget = currentTarget;
      const float failedCurrent = cascadeMeasuredCurrentA;
      const float failedPwm = cascadeSignedPwm;
      const ControlMode failedMode = controlMode;
      motorStop();
      powerPathFaultLatched = true;
      Console.printf("CASCADE no_power_response mode=%s target=%.3fA measured=%.3fA pwm=%.0f latched=1 check_motor_output_or_current_sense\n",
                    failedMode == CONTROL_POSITION ? "position" :
                    failedMode == CONTROL_VELOCITY ? "velocity" : "current",
                    failedTarget, failedCurrent, failedPwm);
      return;
    }
  } else {
    cascadeNoCurrentResponseSinceMs = 0;
  }
  if (nowMs - lastPositionDebugMs >= 100) {
    lastPositionDebugMs = nowMs;
    Console.printf("CASCADE mode=%s pos=%.2f/%.2f vel=%.1f/%.1f current=%.3f/%.3f pwm=%.1f loops=2000/500(position)/200(outer)/100(stream)Hz\n",
                  controlModeName(), encoderMultiTurnDegrees,
                  modelTargetPositionDegrees, encoderVelocityDegreesPerSecond,
                  cascadeVelocityCommandDps, cascadeMeasuredCurrentA,
                  cascadeCurrentCommandA, cascadeSignedPwm);
  }
}

static void finishIdentification(bool success) {
  setPwm(0);
  identificationRunActive = false;
  identificationPhase = 0;
  identificationPhaseUntilMs = 0;
  modelControlActive = false;
  controlMode = CONTROL_IDLE;
  if (success) {
    saveMotorModel();
    Console.printf("IDENTIFY done electrical=%d mechanical=%d samples=%lu/%lu R=%.4f Ke=%.6f accel_per_A=%.1f friction=%.4f\n",
                   modelHasElectricalFit ? 1 : 0, modelHasMechanicalFit ? 1 : 0,
                   static_cast<unsigned long>(modelElectricalSamples),
                   static_cast<unsigned long>(modelMechanicalSamples), modelResistanceOhm,
                   modelKeVoltSecondsPerRad, mechanicalTheta[0], mechanicalTheta[1]);
  } else {
    Console.println("IDENTIFY aborted; PWM=0");
  }
}

static void identificationTick() {
  if (!identificationRunActive) return;
  const uint32_t now = millis();
  if (!driverAwake || digitalRead(PIN_NFAULT) == LOW || readBusVoltage() < 2.0f) {
    finishIdentification(false);
    return;
  }
  if (identificationPhaseUntilMs != 0 && static_cast<int32_t>(now - identificationPhaseUntilMs) >= 0) {
    ++identificationPhase;
    identificationPhaseUntilMs = 0;
    if (identificationPhase >= 8) {
      finishIdentification(modelElectricalSamples >= 20);
      return;
    }
  }
  if (identificationPhaseUntilMs == 0) {
    // 0: settle, then four bounded excitation windows with rests between
    // them. This makes R/Ke and the mechanical ratios observable without an
    // open-ended spin command. STOP aborts the sequence immediately.
    static const uint16_t duties[] = {0, 180, 0, 180, 0, 320, 0, 320};
    static const uint16_t durations[] = {250, 350, 100, 350, 100, 450, 100, 450};
    if (identificationPhase >= 8) { finishIdentification(modelElectricalSamples >= 20); return; }
    const bool forward = identificationPhase == 1 || identificationPhase == 3 || identificationPhase == 5;
    setModelPhase(forward ? 1.0f : -1.0f);
    setPwm(duties[identificationPhase]);
    identificationPhaseUntilMs = now + durations[identificationPhase];
  }
  uint16_t raw = 0;
  float singleDegrees = 0.0f;
  if (!readEncoder(raw, singleDegrees)) return;
  const float busV = readBusVoltage();
  const float currentMv = filterCurrentSenseMillivolts(readCurrentSenseMillivolts());
  latestCurrentMilliamps = readSignedCurrentMilliamps(currentMv);
  updateMotorModel(busV, latestCurrentMilliamps / 1000.0f,
                   encoderVelocityDegreesPerSecond, commandedSignedPwmDuty);
}

static float wrappedAngleError(float target, float actual) {
  float error = target - actual;
  while (error > 180.0f) error -= 360.0f;
  while (error < -180.0f) error += 360.0f;
  return error;
}

static void positionControlTick() {
  if (!positionActive || !driverAwake) return;
  const uint32_t now = millis();
  if (positionPulseOffAtMs != 0 && static_cast<int32_t>(now - positionPulseOffAtMs) >= 0) {
    setPwm(0);
    positionPulseOffAtMs = 0;
  }
  if (!positionHoldActive && !positionSettling && static_cast<int32_t>(now - positionStopAtMs) >= 0) {
    motorStop();
    Console.println("POSITION timeout");
    return;
  }
  if (positionSettling && static_cast<int32_t>(now - positionSettleUntilMs) >= 0) {
    // Do not release the bridge immediately after reaching the one-degree
    // window. Keep a bounded low-duty hold so the 775 rotor does not spring
    // back when the timed move ends.
    positionSettling = false;
    positionHoldActive = true;
    positionHoldStopAtMs = now + 30000;
    Console.println("POSITION hold started");
  }
  if (positionHoldActive && static_cast<int32_t>(now - positionHoldStopAtMs) >= 0) {
    motorStop();
    Console.println("POSITION hold timeout");
    return;
  }
  if (digitalRead(PIN_NFAULT) == LOW) {
    motorStop();
    Console.println("POSITION fault nFAULT=0");
    return;
  }
  // The MT6701 is single-turn. Sample the angle loop at 1 kHz so a fast
  // 775 rotor cannot cross several turns between multi-turn unwrap updates.
  if (now - lastPositionTickMs < 1) return;
  lastPositionTickMs = now;
  uint16_t raw = 0;
  float degrees = 0.0f;
  if (!readEncoder(raw, degrees)) {
    if (++positionEncoderErrorCount >= 5) {
      motorStop();
      Console.println("POSITION encoder_error (5 consecutive bad samples)");
    }
    return;
  }
  positionEncoderErrorCount = 0;
  const uint32_t sampleDtMs = positionLastSampleMs == 0 ? 1 : max<uint32_t>(1, now - positionLastSampleMs);
  const float measuredVelocity = (encoderMultiTurnDegrees - positionLastMultiTurnDegrees) * 1000.0f /
                                 static_cast<float>(sampleDtMs);
  positionVelocityDegreesPerSecond = positionLastSampleMs == 0
                                       ? 0.0f
                                       : positionVelocityDegreesPerSecond * 0.82f + measuredVelocity * 0.18f;
  positionLastMultiTurnDegrees = encoderMultiTurnDegrees;
  positionLastSampleMs = now;
  const float error = positionTargetDeg - encoderMultiTurnDegrees;
  if (fabsf(error) <= 3.0f && fabsf(positionVelocityDegreesPerSecond) < 1000.0f &&
      !positionSettling && !positionHoldActive) {
    positionSettling = true;
    // Give the rotor a short coast/settle window, then engage bounded holding
    // torque. Waiting until the command timeout would leave the motor
    // uncontrolled for seconds and is not closed-loop position control.
    // The 775 rotor still carries noticeable inertia at the crossing point.
    // A long open-loop coast lets it fall several degrees behind the target
    // before the holding controller gets a chance to correct it.
    positionSettleUntilMs = now + 40;
    setPwm(0);
    Console.printf("POSITION reached multi=%.2f target=%.2f velocity=%.0fdeg/s; settling\n",
                  encoderMultiTurnDegrees, positionTargetDeg, positionVelocityDegreesPerSecond);
    return;
  }
  // The 775 motor needs a substantial kick to overcome stiction, but applying
  // full duty all the way to a small target causes a large overshoot. Keep
  // the requested 0..4095 maximum available and shape the duty by distance.
  const float absError = fabsf(error);
  const float activeMaxDuty = static_cast<float>(positionMaxDuty);
  const float velocityTowardTarget = positionVelocityDegreesPerSecond * (error >= 0.0f ? 1.0f : -1.0f);
  if (positionHoldActive && absError <= 4.0f && fabsf(positionVelocityDegreesPerSecond) < 600.0f) {
    // Use sparse low-duty holding pulses inside the dead band. Continuous
    // torque makes this high-speed motor hunt several degrees around target.
    if (static_cast<int32_t>(now - positionHoldNextPulseMs) < 0) {
      setPwm(0);
      return;
    }
    if (error > 0.05f) positionLastPhase = true;
    else if (error < -0.05f) positionLastPhase = false;
    setModelPhase(positionLastPhase ? 1.0f : -1.0f);
    setPwm(min<uint16_t>(45, positionMaxDuty));
    // One millisecond is already a large impulse for this high-speed 775.
    // End the PWM pulse in microseconds, then leave a quiet interval for the
    // encoder to show the mechanical response.
    delayMicroseconds(250);
    setPwm(0);
    positionPulseOffAtMs = 0;
    positionHoldNextPulseMs = now + 20;
    return;
  }
  if (velocityTowardTarget > 1000.0f && absError < 20.0f) {
    // Coast briefly when the rotor is already moving quickly toward the
    // target. This is the braking part of the position loop.
    setPwm(0);
    positionPulseOffAtMs = now + 1;
    return;
  }
  float shapedDuty = activeMaxDuty;
  if (absError < 180.0f) shapedDuty = activeMaxDuty * 0.65f;
  if (absError < 90.0f) shapedDuty = activeMaxDuty * 0.45f;
  if (absError < 30.0f) shapedDuty = activeMaxDuty * 0.28f;
  if (absError < 12.0f) shapedDuty = activeMaxDuty * 0.20f;
  if (absError < 5.0f) shapedDuty = activeMaxDuty * 0.12f;
  if (absError > 1.0f) shapedDuty = max(55.0f, shapedDuty);
  uint16_t duty = static_cast<uint16_t>(absError > 1.0f ? shapedDuty : min(70.0f, activeMaxDuty));
  if (positionHoldActive) {
    // Proportional holding torque: fixed compare values near the target
    // created a visible limit cycle. Grow the holding PWM smoothly with the
    // measured error, while preserving the full user-selected range for the
    // approach portion of the move.
    if (absError <= 4.0f) duty = min<uint16_t>(80, positionMaxDuty);
    else if (absError <= 8.0f) {
      const uint16_t proportionalDuty = static_cast<uint16_t>(absError * 35.0f);
      duty = min<uint16_t>(260, max<uint16_t>(70, proportionalDuty));
      duty = min<uint16_t>(duty, positionMaxDuty);
    } else duty = min<uint16_t>(420, positionMaxDuty);
  } else if (positionSettling && absError <= 0.6f) {
    duty = min<uint16_t>(70, positionMaxDuty);
  }
  // On this board PHASE=HIGH increases the MT6701 angle. Keep the mapping
  // explicit because the shortest-path error changes sign at the wrap point.
  if (error > 0.05f) positionLastPhase = true;
  else if (error < -0.05f) positionLastPhase = false;
  setModelPhase(positionLastPhase ? 1.0f : -1.0f);
  setPwm(duty);
  positionPulseOffAtMs = now + (absError > 8.0f ? 2 : 1);
  if (now - lastPositionDebugMs >= 100) {
    lastPositionDebugMs = now;
    Console.printf("POSITION tick multi=%.2f target=%.2f error=%.2f velocity=%.0f phase=%d duty=%u\n",
                  encoderMultiTurnDegrees, positionTargetDeg, error, positionVelocityDegreesPerSecond,
                  digitalRead(PIN_PHASE), duty);
  }
}

static void printStatus() {
  uint16_t raw = encoderPreviousRaw;
  float degrees = encoderLastSingleTurnDegrees;
  const bool encOk = modelControlActive ? encoderTurnInitialized
                                        : readEncoder(raw, degrees);
  float busAdcMv = 0.0f;
  const float sampledBusV = readBusVoltage(&busAdcMv);
  const float busV = modelControlActive ? cascadeBusVoltage : sampledBusV;
  // STATUS is a diagnostic snapshot. Always report the real ADC pin voltage;
  // the previous active-control path substituted the stored zero and made a
  // live current signal look electrically flat even while the loop ran.
  const float currentRawMv = readCurrentSenseMillivolts();
  if (!modelControlActive) trackCurrentZeroAtIdle(currentRawMv);
  const float currentMv = modelControlActive
      ? currentRawMv : filterCurrentSenseMillivolts(currentRawMv);
  const float currentMa = modelControlActive ? cascadeMeasuredCurrentA * 1000.0f
                                             : readSignedCurrentMilliamps(currentMv);
  latestCurrentMilliamps = currentMa;
  Console.printf("STATUS bus=%.2fV bus_adc=%.0fmV angle=%s%.2fdeg multi=%s%.2fdeg velocity=%.1fdeg/s raw=%u nFAULT=%d awake=%d step=%u pwm=%u/4095 current_adc=%.0fmV current_raw=%.0fmV current_zero=%.0fmV motor_current=%.0fmA control=%s target=%.2f\n",
                busV, busAdcMv, encOk ? "" : "ERR ", degrees, encOk ? "" : "ERR ", encoderMultiTurnDegrees,
                encoderVelocityDegreesPerSecond, raw,
                digitalRead(PIN_NFAULT), driverAwake ? 1 : 0,
                static_cast<unsigned>(currentStep), static_cast<unsigned>(pwmDuty()), currentMv, currentRawMv,
                currentZeroMillivolts, currentMa,
                controlModeName(), modelTargetForTelemetry());
}

static void streamTick() {
  if (!streamEnabled) return;
  const uint32_t nowUs = micros();
  const uint32_t periodUs = max<uint32_t>(1000, 1000000u / streamRateHz);
  if (nextStreamAtUs != 0 && static_cast<int32_t>(nowUs - nextStreamAtUs) < 0) return;
  // Advance from the previous deadline instead of adding the period to the
  // current time, so USB/ADC work does not accumulate scheduling drift.
  if (nextStreamAtUs == 0 || static_cast<int32_t>(nowUs - nextStreamAtUs) >
                              static_cast<int32_t>(periodUs * 4u)) {
    nextStreamAtUs = nowUs + periodUs;
  } else {
    nextStreamAtUs += periodUs;
  }
  // Reuse the sample accepted by the idle tracker or the active controller.
  // A second immediate I2C read here would have almost zero delta and would
  // drag the shared velocity filter toward zero every 10 ms.
  uint16_t raw = encoderPreviousRaw;
  float singleTurnDegrees = encoderLastSingleTurnDegrees;
  if (!encoderTurnInitialized && !readEncoder(raw, singleTurnDegrees)) return;
  const float busV = modelControlActive ? cascadeBusVoltage : readBusVoltage();
  float currentMa = cascadeMeasuredCurrentA * 1000.0f;
  if (!modelControlActive) {
    const float currentRawMv = readCurrentSenseMillivolts();
    trackCurrentZeroAtIdle(currentRawMv);
    const float currentMv = filterCurrentSenseMillivolts(currentRawMv);
    currentMa = readSignedCurrentMilliamps(currentMv);
  }
  latestCurrentMilliamps = currentMa;
  // Compact USB CDC frame at 100 Hz. Append-only fields preserve old parsers:
  // S,t_ms,single,multi,bus_v,current_ma,pwm_abs,nFAULT,awake,step,raw,
  // velocity,control,target,phase,pwm_signed,pid_raw,pid_applied,stall_boost,
  // settled,velocity_target,current_target_ma,current_measured_ma,cascade_pwm,
  // raw_velocity_dps.
  Console.printf("S,%lu,%.2f,%.2f,%.2f,%.0f,%u,%d,%d,%u,%u,%.1f,%u,%.2f,%d,%d,%.1f,%.1f,%.1f,%d,%.1f,%.0f,%.0f,%.1f,%.1f\n",
                static_cast<unsigned long>(nowUs / 1000u), singleTurnDegrees, encoderMultiTurnDegrees,
                busV, currentMa, static_cast<unsigned>(pwmDuty()), digitalRead(PIN_NFAULT),
                driverAwake ? 1 : 0, static_cast<unsigned>(currentStep), raw,
                encoderVelocityDegreesPerSecond, static_cast<unsigned>(controlMode),
                modelTargetForTelemetry(), digitalRead(PIN_PHASE),
                static_cast<int>(signedPwmDuty()), latestPositionPidRawPwm,
                latestPositionPidAppliedPwm, positionPidStallBoostPwm,
                cascadePositionSettled ? 1 : 0, cascadeVelocityCommandDps,
                cascadeCurrentCommandA * 1000.0f,
                cascadeMeasuredCurrentA * 1000.0f, cascadeSignedPwm,
                encoderRawVelocityDegreesPerSecond);
}

static void setDriverAwake(bool awake) {
  // WAKE is a state-setting command, not a destructive reset command. The
  // web server and UI can both request readiness; making an already-awake
  // WAKE call motorStop() used to cancel a motion that had just started.
  // A deliberate recovery reset remains available as sleep -> wake.
  if (awake && driverAwake) {
    digitalWrite(PIN_NSLEEP, HIGH);
    digitalWrite(PIN_NRESET, HIGH);
    return;
  }
  motorStop();
  if (awake) {
    // Always execute a deterministic reset/wake sequence. Raising nSLEEP and
    // nRESET together left the bridge state dependent on its previous power
    // state and could produce an awake-looking driver that ignored ENBL.
    digitalWrite(PIN_NRESET, LOW);
    digitalWrite(PIN_NSLEEP, LOW);
    delay(2);
    digitalWrite(PIN_NSLEEP, HIGH);
    delay(2);
    digitalWrite(PIN_NRESET, HIGH);
    delay(10);
    driverAwake = true;
    // INA240/ADC zero shifts slightly when the driver leaves reset. Re-zero
    // with PWM=0 so the reported value is motor branch current, not offset.
    calibrateCurrentZero();
  } else {
    digitalWrite(PIN_NSLEEP, LOW);
    digitalWrite(PIN_NRESET, LOW);
    driverAwake = false;
  }
}

static uint16_t busCrc16(const uint8_t *data, size_t length) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < length; ++i) {
    crc ^= static_cast<uint16_t>(data[i]) << 8;
    for (uint8_t bit = 0; bit < 8; ++bit) {
      crc = (crc & 0x8000) ? static_cast<uint16_t>((crc << 1) ^ 0x1021)
                           : static_cast<uint16_t>(crc << 1);
    }
  }
  return crc;
}

static uint8_t defaultBusAddress() {
  const uint64_t uid = ESP.getEfuseMac();
  const uint64_t mixed = uid ^ (uid >> 8) ^ (uid >> 16) ^ (uid >> 24) ^ (uid >> 32) ^ (uid >> 40);
  return static_cast<uint8_t>((mixed % 200u) + 1u);
}

static void loadBusAddress() {
  Preferences preferences;
  preferences.begin("buscfg", true);
  const uint8_t stored = preferences.getUChar("addr", 0);
  preferences.end();
  busAddress = stored >= 1 && stored <= 254 ? stored : defaultBusAddress();
}

static bool saveBusAddress(uint8_t address) {
  if (address == 0 || address == BUS_BROADCAST) return false;
  Preferences preferences;
  if (!preferences.begin("buscfg", false)) return false;
  const size_t written = preferences.putUChar("addr", address);
  preferences.end();
  if (written != 1) return false;
  busAddress = address;
  return true;
}

static void busSendFrame(uint8_t destination, uint8_t type, uint8_t sequence,
                         const uint8_t *payload, uint8_t payloadLength) {
  if (payloadLength > BUS_MAX_PAYLOAD) return;
  ++busFrameTxCount;
  if (type == BUS_TYPE_RESPONSE || type == BUS_TYPE_STATUS ||
      type == BUS_TYPE_PONG || type == BUS_TYPE_SYNC) {
    ++busResponseTxCount;
  }
  uint8_t frame[10 + BUS_MAX_PAYLOAD] = {};
  frame[0] = BUS_MAGIC_1;
  frame[1] = BUS_MAGIC_2;
  frame[2] = BUS_VERSION;
  frame[3] = destination;
  frame[4] = busAddress;
  frame[5] = sequence;
  frame[6] = type;
  frame[7] = payloadLength;
  if (payloadLength && payload) memcpy(frame + 8, payload, payloadLength);
  const uint16_t crc = busCrc16(frame + 2, 6 + payloadLength);
  frame[8 + payloadLength] = static_cast<uint8_t>(crc & 0xFF);
  frame[9 + payloadLength] = static_cast<uint8_t>(crc >> 8);
  const size_t frameLength = 10 + payloadLength;
  BusSerial.write(frame, frameLength);
  BusSerial.flush();
}

static const char *syncModeName() {
  if (syncMode == SYNC_POSITION) return "position";
  if (syncMode == SYNC_FORCE) return "force";
  return "off";
}

static void syncResetLinkCounters() {
  syncNextTxUs = 0;
  syncLastTxUs = 0;
  syncLastRxUs = 0;
  syncSequence = 0;
  syncTxCount = 0;
  syncRxCount = 0;
  syncRequestTxCount = 0;
  syncResponseTxCount = 0;
  syncRequestRxCount = 0;
  syncResponseRxCount = 0;
  syncLinkFailed = false;
  syncTimeoutCount = 0;
  syncControlRunning = false;
  syncRemotePositionDeg = 0.0f;
  syncRemoteVelocityDps = 0.0f;
  syncRemoteCurrentMa = 0.0f;
  syncRemoteCommandPositionDeg = 0.0f;
  syncRemoteCommandVelocityDps = 0.0f;
  syncRemoteCommandCurrentMa = 0.0f;
  syncRemotePwm = 0;
  syncRemoteFault = 0;
  syncRemoteAwake = 0;
}

static void syncSendState(uint8_t kind) {
  if (syncPeerAddress == 0 || syncPeerAddress == busAddress) return;
  SyncWirePayload payload = {};
  payload.version = SYNC_PAYLOAD_VERSION;
  payload.kind = kind;
  payload.mode = static_cast<uint8_t>(syncMode);
  payload.timestampUs = micros();
  payload.positionDeg = encoderMultiTurnDegrees;
  payload.velocityDps = encoderVelocityDegreesPerSecond;
  // Keep ADC work out of the 200 Hz wire slot. The active 2 kHz controller or
  // the 100 Hz stream refreshes this cache before it is sent on the bus.
  payload.currentMa = latestCurrentMilliamps;
  // The lower DATA address is the synchronization leader. Its command is
  // carried explicitly so the follower tracks the commanded trajectory,
  // rather than making both nodes overwrite their targets with each other's
  // measured position.
  payload.commandPositionDeg = controlMode == CONTROL_POSITION
                                   ? modelTargetPositionDegrees
                                   : (positionActive ? positionTargetDeg : encoderMultiTurnDegrees);
  payload.commandVelocityDps = controlMode == CONTROL_VELOCITY
                                   ? modelTargetVelocityDps
                                   : 0.0f;
  payload.commandCurrentMa = controlMode == CONTROL_CURRENT
                                 ? modelTargetCurrentAmps * 1000.0f
                                 : 0.0f;
  payload.pwm = pwmDuty();
  payload.fault = digitalRead(PIN_NFAULT) ? 1 : 0;
  payload.awake = driverAwake ? 1 : 0;
  busSendFrame(syncPeerAddress, BUS_TYPE_SYNC, ++syncSequence,
               reinterpret_cast<const uint8_t *>(&payload), sizeof(payload));
  syncLastTxUs = payload.timestampUs;
  ++syncTxCount;
  if (kind == 0) ++syncRequestTxCount;
  else ++syncResponseTxCount;
}

static void syncApplyRemoteState() {
  if (!syncMotionArmed || syncMode == SYNC_OFF || syncPeerAddress == 0) return;
  const uint32_t nowUs = micros();
  const bool leader = busAddress < syncPeerAddress;
  if (!driverAwake || !syncRemoteAwake || syncRemoteFault == 0 ||
      syncLastRxUs == 0 || nowUs - syncLastRxUs > SYNC_LINK_TIMEOUT_US) {
    // A synchronized pair is fail-safe on either side. The leader also has
    // to stop its local trajectory when its follower disappears; otherwise a
    // later reconnect could resume with a stale phase/target.
    if (!syncLinkFailed && (syncControlRunning || leader)) {
      Console.printf("SYNC_STOP local_awake=%d remote_awake=%d remote_fault=%d age=%luus leader=%d\n",
                    driverAwake ? 1 : 0, syncRemoteAwake ? 1 : 0,
                    syncRemoteFault ? 1 : 0,
                    static_cast<unsigned long>(syncLastRxUs == 0 ? 0 : nowUs - syncLastRxUs),
                    leader ? 1 : 0);
      // Remove motor torque immediately, but keep the synchronization session
      // armed. A hard motorStop() used to disarm both nodes permanently at the
      // first 30 ms burst of motor EMI, so the requester stopped transmitting
      // and the link could never recover after the bridge went quiet.
      const bool keepSyncArmed = syncMotionArmed;
      motorStop();
      syncMotionArmed = keepSyncArmed;
      syncControlRunning = false;
      syncLinkFailed = true;
      ++syncTimeoutCount;
    }
    return;
  }

  if (syncLinkFailed) {
    syncLinkFailed = false;
    Console.printf("SYNC_RECOVER age=%luus leader=%d\n",
                  static_cast<unsigned long>(nowUs - syncLastRxUs),
                  leader ? 1 : 0);
  }

  if (syncMode == SYNC_POSITION) {
    // Only the follower consumes the leader's command. The leader keeps the
    // target received from USB/model control and uses the bus solely for
    // timestamped state exchange and link supervision.
    if (leader) {
      syncControlRunning = false;
      return;
    }
    const float target = syncRemoteCommandPositionDeg + syncPositionOffsetDeg;
    if (!syncControlRunning || controlMode != CONTROL_POSITION) {
      resetCascadeController();
      modelControlActive = true;
      controlMode = CONTROL_POSITION;
      modelCurrentIntegral = 0.0f;
      modelVelocityIntegral = 0.0f;
      positionPidIntegral = 0.0f;
      positionPidPulseAccumulator = 0.0f;
      lastModelTickMs = 0;
      modelStartBoostUntilMs = millis() + 20;
    }
    modelTargetPositionDegrees = target;
    modelTargetVelocityDps = 0.0f;
    modelTargetCurrentAmps = 0.0f;
    modelMaxDuty = syncMaxDuty;
    modelStopAtMs = millis() + syncTimeoutMs;
  } else if (syncMode == SYNC_FORCE) {
    const float positionError = syncRemotePositionDeg + syncPositionOffsetDeg -
                                 encoderMultiTurnDegrees;
    const float velocityError = syncRemoteVelocityDps -
                                encoderVelocityDegreesPerSecond;
    // Motor current is the available torque proxy. The spring/damper term
    // couples the two encoder states; reflectionGain optionally mirrors the
    // remote branch current for a bilateral force-feedback experiment.
    // Remote motor current is the torque exerted by that motor. The reaction
    // felt by the peer has the opposite sign, hence the subtraction below.
    // With reflection=0 this remains a passive virtual spring-damper pair.
    const float commandedMa = syncStiffnessMaPerDeg * positionError +
                              syncDampingMaPerDps * velocityError -
                              syncReflectionGain * syncRemoteCurrentMa;
    const float limitedMa = constrain(commandedMa, -syncCurrentLimitMa,
                                      syncCurrentLimitMa);
    if (!syncControlRunning || controlMode != CONTROL_CURRENT) {
      setCurrentStep(3);
      resetCascadeController();
      modelControlActive = true;
      controlMode = CONTROL_CURRENT;
      modelCurrentIntegral = 0.0f;
      modelVelocityIntegral = 0.0f;
      lastModelTickMs = 0;
    }
    modelTargetCurrentAmps = limitedMa / 1000.0f;
    modelTargetVelocityDps = 0.0f;
    modelTargetPositionDegrees = syncRemotePositionDeg + syncPositionOffsetDeg;
    modelMaxDuty = syncMaxDuty;
    modelStopAtMs = millis() + syncTimeoutMs;
  }
  syncControlRunning = true;
}

static void syncHandleFrame(uint8_t source, const uint8_t *payloadBytes,
                            uint8_t payloadLength) {
  if (source != syncPeerAddress || payloadLength != sizeof(SyncWirePayload)) return;
  SyncWirePayload payload = {};
  memcpy(&payload, payloadBytes, sizeof(payload));
  if (payload.version != SYNC_PAYLOAD_VERSION || payload.kind > 1) return;
  // The lower address is the only requester and the higher address is the only
  // responder. Reject an unexpected role before it refreshes the watchdog.
  const bool leader = busAddress < syncPeerAddress;
  if ((leader && payload.kind != 1) || (!leader && payload.kind != 0)) return;
  syncRemotePositionDeg = payload.positionDeg;
  syncRemoteVelocityDps = payload.velocityDps;
  syncRemoteCurrentMa = payload.currentMa;
  syncRemoteCommandPositionDeg = payload.commandPositionDeg;
  syncRemoteCommandVelocityDps = payload.commandVelocityDps;
  syncRemoteCommandCurrentMa = payload.commandCurrentMa;
  syncRemotePwm = payload.pwm;
  syncRemoteFault = payload.fault;
  syncRemoteAwake = payload.awake;
  syncLastRxUs = micros();
  ++syncRxCount;
  if (payload.kind == 0) ++syncRequestRxCount;
  else ++syncResponseRxCount;
  syncApplyRemoteState();
  if (payload.kind == 0) syncSendState(1);
}

static void syncTick() {
  if (!syncMotionArmed || syncMode == SYNC_OFF || syncPeerAddress == 0 ||
      !driverAwake) return;
  const uint32_t nowUs = micros();
  if (syncLastTxUs != 0 && syncLastRxUs == 0 &&
      nowUs - syncLastTxUs > SYNC_LINK_TIMEOUT_US) {
    syncApplyRemoteState();
  } else if (syncLastRxUs != 0 && nowUs - syncLastRxUs > SYNC_LINK_TIMEOUT_US) {
    syncApplyRemoteState();
  }
  // The lower address owns the request slot. The other node only responds,
  // which prevents two independent transmitters from colliding on DATA.
  if (busAddress < syncPeerAddress &&
      (syncNextTxUs == 0 || static_cast<int32_t>(nowUs - syncNextTxUs) >= 0)) {
    syncSendState(0);
    syncNextTxUs = nowUs + SYNC_PERIOD_US;
  }
}

static void busSendText(uint8_t destination, uint8_t type, uint8_t sequence,
                        const String &text) {
  const uint8_t length = static_cast<uint8_t>(min<size_t>(BUS_MAX_PAYLOAD, text.length()));
  busSendFrame(destination, type, sequence,
               reinterpret_cast<const uint8_t *>(text.c_str()), length);
}

static void busStartTransaction(uint8_t destination, uint8_t sequence,
                                const String &command) {
  const uint8_t length = static_cast<uint8_t>(min<size_t>(BUS_MAX_PAYLOAD, command.length()));
  busSendFrame(destination, BUS_TYPE_COMMAND, sequence,
               reinterpret_cast<const uint8_t *>(command.c_str()), length);
  if (destination == BUS_BROADCAST) return;
  busTransactionActive = true;
  busPendingDestination = destination;
  busPendingSequence = sequence;
  busPendingType = BUS_TYPE_COMMAND;
  busPendingLength = length;
  memcpy(busPendingPayload, command.c_str(), length);
  busPendingRetries = 0;
  busPendingDeadlineMs = millis() + 80;
}

static void busTransactionTick() {
  if (!busTransactionActive || static_cast<int32_t>(millis() - busPendingDeadlineMs) < 0) return;
  if (busPendingRetries < 2) {
    ++busPendingRetries;
    busSendFrame(busPendingDestination, busPendingType, busPendingSequence,
                 busPendingPayload, busPendingLength);
    busPendingDeadlineMs = millis() + 80;
    Console.printf("BUS_RETRY dest=%u seq=%u attempt=%u\n",
                   static_cast<unsigned>(busPendingDestination),
                   static_cast<unsigned>(busPendingSequence),
                   static_cast<unsigned>(busPendingRetries + 1));
    return;
  }
  Console.printf("BUS_TIMEOUT dest=%u seq=%u retries=%u\n",
                 static_cast<unsigned>(busPendingDestination),
                 static_cast<unsigned>(busPendingSequence),
                 static_cast<unsigned>(busPendingRetries));
  busTransactionActive = false;
}

static void busSendStatus(uint8_t destination, uint8_t sequence) {
  uint16_t raw = 0;
  float singleDegrees = 0.0f;
  readEncoder(raw, singleDegrees);
  const float busV = readBusVoltage();
  const float currentMv = filterCurrentSenseMillivolts(readCurrentSenseMillivolts());
  const float currentMa = readSignedCurrentMilliamps(currentMv);
  latestCurrentMilliamps = currentMa;
  char status[BUS_MAX_PAYLOAD + 1] = {};
  snprintf(status, sizeof(status),
           "STATUS,%u,%.2f,%.2f,%.2f,%.0f,%u,%d,%d,%u,%.1f,%u,%.2f",
           static_cast<unsigned>(busAddress), singleDegrees, encoderMultiTurnDegrees,
           busV, currentMa, static_cast<unsigned>(pwmDuty()), digitalRead(PIN_NFAULT),
           driverAwake ? 1 : 0, static_cast<unsigned>(currentStep),
           encoderVelocityDegreesPerSecond, static_cast<unsigned>(controlMode),
           modelTargetForTelemetry());
  busSendText(destination, BUS_TYPE_STATUS, sequence, String(status));
}

static void busHandleCommand(uint8_t source, uint8_t sequence, uint8_t destination,
                             const String &command);
static void handleCommand(String cmd);

static bool busHandleFrame(const uint8_t *frame, uint16_t frameLength) {
  if (frameLength < 10 || frame[0] != BUS_MAGIC_1 || frame[1] != BUS_MAGIC_2 ||
      frame[2] != BUS_VERSION || frame[7] > BUS_MAX_PAYLOAD ||
      frameLength != static_cast<uint16_t>(10 + frame[7])) return false;
  const uint16_t receivedCrc = static_cast<uint16_t>(frame[8 + frame[7]]) |
                               static_cast<uint16_t>(frame[9 + frame[7]]) << 8;
  const uint16_t calculatedCrc = busCrc16(frame + 2, 6 + frame[7]);
  if (receivedCrc != calculatedCrc) {
    ++busCrcErrorCount;
    return false;
  }
  ++busValidFrameCount;
  const uint8_t destination = frame[3];
  if (destination != busAddress && destination != BUS_BROADCAST) return true;
  ++busAddressedFrameCount;
  const uint8_t source = frame[4];
  const uint8_t sequence = frame[5];
  const uint8_t type = frame[6];
  if (type == BUS_TYPE_SYNC) {
    syncHandleFrame(source, frame + 8, frame[7]);
    return true;
  }
  String payload;
  for (uint8_t i = 0; i < frame[7]; ++i) payload += static_cast<char>(frame[8 + i]);
  if (type == BUS_TYPE_COMMAND) {
    ++busCommandRxCount;
    busHandleCommand(source, sequence, destination, payload);
  } else {
    if (type != BUS_TYPE_SYNC && busTransactionActive && source == busPendingDestination &&
        sequence == busPendingSequence) {
      busTransactionActive = false;
      Console.printf("BUS_ACK from=%u type=%u seq=%u\n",
                     static_cast<unsigned>(source), static_cast<unsigned>(type),
                     static_cast<unsigned>(sequence));
    }
    Console.printf("BUS_RX from=%u type=%u seq=%u payload=%s\n",
                   static_cast<unsigned>(source), static_cast<unsigned>(type),
                   static_cast<unsigned>(sequence), payload.c_str());
  }
  return true;
}

static void busResyncFrame(uint8_t *frame, uint16_t &received) {
  ++busResyncCount;
  for (uint16_t index = 1; index + 1 < received; ++index) {
    if (frame[index] == BUS_MAGIC_1 && frame[index + 1] == BUS_MAGIC_2) {
      const uint16_t remaining = received - index;
      memmove(frame, frame + index, remaining);
      received = remaining;
      return;
    }
  }
  if (received != 0 && frame[received - 1] == BUS_MAGIC_1) {
    frame[0] = BUS_MAGIC_1;
    received = 1;
  } else {
    received = 0;
  }
}

static void busProcessByte(uint8_t byte) {
  static uint8_t frame[10 + BUS_MAX_PAYLOAD] = {};
  static uint16_t received = 0;
  ++busRxByteCount;
  if (received >= sizeof(frame)) {
    busResyncFrame(frame, received);
    if (received >= sizeof(frame)) received = 0;
  }
  frame[received++] = byte;
  bool inspectAgain = true;
  while (inspectAgain) {
    inspectAgain = false;
    if (received == 1 && frame[0] != BUS_MAGIC_1) {
      received = 0;
      continue;
    }
    if (received >= 2 &&
        (frame[0] != BUS_MAGIC_1 || frame[1] != BUS_MAGIC_2)) {
      busResyncFrame(frame, received);
      inspectAgain = received >= 2;
      continue;
    }
    if (received >= 3 && frame[2] != BUS_VERSION) {
      busResyncFrame(frame, received);
      inspectAgain = received >= 2;
      continue;
    }
    if (received >= 8) {
      const uint16_t expected = static_cast<uint16_t>(10 + frame[7]);
      if (frame[7] > BUS_MAX_PAYLOAD || expected > sizeof(frame)) {
        busResyncFrame(frame, received);
        inspectAgain = received >= 2;
        continue;
      }
      if (received >= expected) {
        if (busHandleFrame(frame, expected)) {
          const uint16_t remaining = received - expected;
          if (remaining) memmove(frame, frame + expected, remaining);
          received = remaining;
        } else {
          busResyncFrame(frame, received);
        }
        inspectAgain = received != 0;
      }
    }
  }
}

static void busProcessRx() {
  while (BusSerial.available()) {
    busProcessByte(static_cast<uint8_t>(BusSerial.read()));
  }
}

static void busHandleCommand(uint8_t source, uint8_t sequence, uint8_t destination,
                             const String &command) {
  const bool broadcast = destination == BUS_BROADCAST;
  auto reply = [&](const String &text, bool ok = true) {
    if (!broadcast) busSendText(source, BUS_TYPE_RESPONSE, sequence,
                                String(ok ? "ACK," : "NACK,") + String(sequence) + "," + text);
  };
  if (command == "ping") {
    if (!broadcast) {
      String pong = String("PONG,addr=") + String(busAddress) + ",uid=" +
                    String(static_cast<unsigned long long>(ESP.getEfuseMac()), HEX);
      busSendText(source, BUS_TYPE_PONG, sequence, pong);
    }
    return;
  }
  if (command == "status") {
    if (!broadcast) busSendStatus(source, sequence);
    return;
  }
  if (command == "arm") {
    // Compatibility ACK for old dashboards. Motion no longer depends on an
    // expiring hidden arm latch.
    reply(String("arm_not_required addr=") + String(busAddress));
    return;
  }
  if (command == "disarm") {
    motorStop();
    reply("stopped pwm=0");
    return;
  }
  if (command == "stop") {
    motorStop();
    reply("stop pwm=0");
    return;
  }
  if (command == "wake") {
    const bool resetPerformed = !driverAwake;
    setDriverAwake(true);
    reply(String("awake=1 pwm=") + String(pwmDuty()) +
          " reset=" + String(resetPerformed ? 1 : 0));
    return;
  }
  if (command == "sleep") {
    setDriverAwake(false);
    reply("awake=0 pwm=0");
    return;
  }
  if (command == "identify start") {
    handleCommand(command);
    reply("executed=identify start");
    return;
  }
  if (command.startsWith("pos ") || command.startsWith("velocity ") ||
      command.startsWith("current ") || command.startsWith("cw ") || command.startsWith("ccw ")) {
    handleCommand(command);
    reply(String("executed=") + command);
    return;
  }
  reply("unknown command", false);
}

static bool parseUInt(const String &s, int &value) {
  if (s.length() == 0) return false;
  for (size_t i = 0; i < s.length(); ++i) {
    if (!isDigit(s[i])) return false;
  }
  value = s.toInt();
  return true;
}

static void printHelp() {
  Console.println("Commands: help | status | diag | dctest cw|ccw 1..200 | encoder | encreset | rawadc | model | cascade status|current KP KI MAX_PWM|velocity KP KI MAX_A|low_speed_current A|breakaway CURRENT_A MAX_MS RETRY_MS SPEED_DPS [RAMP_A_PER_S]|position KP KI KD MAX_DPS DEAD|trajectory MAX_DPS ACCEL_DPS2 JERK_DPS3 BANDWIDTH | pospid ... | direction normal|invert | sensepolarity normal|invert | identify on|off|reset|start | current mA D MS | velocity DPS D MS | pos MULTI_DEG D MS | businfo | busbaud 115200|250000|500000|750000|1000000 | busaddr 1..254 | bus ADDR ... | sync ... | wake | sleep | stop | stream 1..100|off | cw D MS | ccw D MS | setstep 0..3 | decay slow|fast | led on|off");
  Console.println("D=0..4095 (0..100%), MS=1..30000. Cascade rates: current=2000 Hz, position velocity=500 Hz, position=200 Hz, USB stream=100 Hz. Position output is velocity; velocity output is current; current output is PWM.");
}

static void handleCommand(String cmd) {
  cmd.trim();
  if (!cmd.length()) return;
  const int firstSpace = cmd.indexOf(' ');
  const String op = firstSpace < 0 ? cmd : cmd.substring(0, firstSpace);
  String rest = firstSpace < 0 ? String() : cmd.substring(firstSpace + 1);
  rest.trim();

  const bool requestsMotion = op == "dctest" || op == "lapatest" ||
      op == "current" || op == "velocity" || op == "vel" || op == "pos" ||
      op == "cw" || op == "ccw" || op == "identify" ||
      (op == "sync" && rest != "off" && rest != "stop" &&
       rest != "disarm" && rest != "status");
  if (powerPathFaultLatched && requestsMotion) {
    Console.println("ERR power_path_fault_latched; inspect motor output/current sense then run recover");
    return;
  }

  if (op == "help") {
    printHelp();
  } else if (op == "status") {
    printStatus();
  } else if (op == "diag") {
    Console.printf("DIAG enbl_pwm=%u signed_pwm=%d pwm_hz=%.0f pwm_ok=%d phase=%d nsleep=%d nreset=%d i0=%d i1=%d decay=%d nfault=%d awake=%d drive=%s active=%d power_fault=%d\n",
                  static_cast<unsigned>(pwmDuty()),
                  static_cast<int>(signedPwmDuty()), pwmConfiguredHz,
                  pwmConfiguredHz > 0.0 ? 1 : 0, digitalRead(PIN_PHASE),
                  digitalRead(PIN_NSLEEP), digitalRead(PIN_NRESET),
                  digitalRead(PIN_I0), digitalRead(PIN_I1),
                  digitalRead(PIN_DECAY), digitalRead(PIN_NFAULT),
                  driverAwake ? 1 : 0,
                  bridgeDriveMode == DRIVE_LOCKED_ANTIPHASE ? "locked" : "sign",
                  lockedAntiphaseActive ? 1 : 0,
                  powerPathFaultLatched ? 1 : 0);
  } else if (op == "dctest") {
    char direction[4] = {};
    int duration = 0;
    if (sscanf(rest.c_str(), "%3s %d", direction, &duration) != 2 ||
        (strcmp(direction, "cw") != 0 && strcmp(direction, "ccw") != 0) ||
        duration < 1 || duration > 200) {
      Console.println("ERR usage: dctest cw|ccw 1..200");
      return;
    }
    runDirectBridgeTest(strcmp(direction, "cw") == 0, static_cast<uint16_t>(duration));
  } else if (op == "lapatest") {
    int offset = 0, duration = 0;
    if (sscanf(rest.c_str(), "%d %d", &offset, &duration) != 2 ||
        offset < -512 || offset > 512 || duration < 1 || duration > 1000) {
      Console.println("ERR usage: lapatest offset_counts(-512..512) duration_ms(1..1000)");
      return;
    }
    runLockedAntiphaseTest(static_cast<int16_t>(offset),
                           static_cast<uint16_t>(duration));
  } else if (op == "drivemode") {
    if (rest != "sign" && rest != "locked") {
      Console.println("ERR usage: drivemode sign|locked");
      return;
    }
    motorStop();
    bridgeDriveMode = rest == "locked" ? DRIVE_LOCKED_ANTIPHASE
                                         : DRIVE_SIGN_MAGNITUDE;
    resetCascadeController();
    Console.printf("OK drivemode=%s zero=%s\n", rest.c_str(),
                  bridgeDriveMode == DRIVE_LOCKED_ANTIPHASE ? "phase_50pct" : "enbl_0pct");
  } else if (op == "cascade") {
    if (rest == "status") {
      Console.printf("CASCADE_CFG current_hz=2000 kp=%.3f ki=%.3f max_pwm=%.0f velocity_hz=200 kp=%.6f ki=%.6f max_current=%.3fA friction=%.3fA current_slew=%.2fA/s brake_slew_x=%.1f position_velocity_hz=500 position_hz=200 kp=%.3f ki=%.3f kd=%.3f max_velocity=%.1f acceleration=%.1f jerk=%.1f bandwidth=%.2f deadband=%.2f low_speed_current=%.3fA breakaway=%.3fA/%.1fms retry=%.1fms speed=%.1fdeg/s ramp=%.1fA/s\n",
                    cascadeCurrentKp, cascadeCurrentKi, cascadeCurrentMaxPwm,
                    cascadeVelocityKp, cascadeVelocityKi,
                    cascadeVelocityMaxCurrentA, cascadeVelocityFrictionA,
                    cascadeVelocityCurrentSlewAps,
                    cascadeVelocityBrakeSlewMultiplier,
                    cascadePositionKp, cascadePositionKi, cascadePositionKd,
                    cascadePositionMaxVelocityDps,
                    cascadePositionMaxAccelerationDps2,
                    cascadePositionMaxJerkDps3,
                    cascadeTrajectoryBandwidthRadS,
                    cascadePositionDeadbandDeg,
                    cascadePositionLowSpeedCurrentA,
                    cascadeBreakawayPulseCurrentA, cascadeBreakawayPulseMs,
                    cascadeBreakawayRetryMs, cascadeBreakawayPulseSpeedDps,
                    cascadeBreakawayRampAps);
    } else if (rest.startsWith("current ")) {
      float kp = 0.0f, ki = 0.0f, maxPwm = 0.0f;
      if (sscanf(rest.c_str(), "current %f %f %f", &kp, &ki, &maxPwm) != 3 ||
          !isfinite(kp) || !isfinite(ki) || !isfinite(maxPwm) ||
          kp < 0.0f || kp > 5000.0f || ki < 0.0f || ki > 100000.0f ||
          maxPwm < 1.0f || maxPwm > PWM_MAX) {
        Console.println("ERR usage: cascade current KP(0..5000) KI(0..100000) MAX_PWM(1..4095)");
        return;
      }
      cascadeCurrentKp = kp; cascadeCurrentKi = ki; cascadeCurrentMaxPwm = maxPwm;
      cascadeCurrentIntegral = 0.0f;
      Console.printf("OK cascade_current kp=%.3f ki=%.3f max_pwm=%.0f hz=2000\n", kp, ki, maxPwm);
    } else if (rest.startsWith("velocity ")) {
      float kp = 0.0f, ki = 0.0f, maxCurrent = 0.0f, friction = cascadeVelocityFrictionA;
      float currentSlew = cascadeVelocityCurrentSlewAps;
      float brakeSlewMultiplier = cascadeVelocityBrakeSlewMultiplier;
      const int parsed = sscanf(rest.c_str(), "velocity %f %f %f %f %f %f", &kp, &ki,
                                &maxCurrent, &friction, &currentSlew,
                                &brakeSlewMultiplier);
      if ((parsed < 3 || parsed > 6) ||
          !isfinite(kp) || !isfinite(ki) || !isfinite(maxCurrent) ||
          !isfinite(friction) || !isfinite(currentSlew) ||
          !isfinite(brakeSlewMultiplier) ||
          kp < 0.0f || kp > 1.0f || ki < 0.0f || ki > 1.0f ||
          maxCurrent < 0.05f || maxCurrent > 7.0f ||
          friction < 0.0f || friction > 5.0f ||
          currentSlew < 0.1f || currentSlew > 100.0f ||
          brakeSlewMultiplier < 1.0f || brakeSlewMultiplier > 50.0f) {
        Console.println("ERR usage: cascade velocity KP(0..1) KI(0..1) MAX_CURRENT_A(0.05..7) [FRICTION_A(0..5)] [CURRENT_SLEW_A_PER_S(0.1..100)] [BRAKE_SLEW_MULTIPLIER(1..50)]");
        return;
      }
      cascadeVelocityKp = kp; cascadeVelocityKi = ki;
      cascadeVelocityMaxCurrentA = maxCurrent;
      cascadeVelocityFrictionA = friction;
      cascadeVelocityCurrentSlewAps = currentSlew;
      cascadeVelocityBrakeSlewMultiplier = brakeSlewMultiplier;
      cascadeVelocityIntegral = 0.0f;
      cascadeVelocityBreakawayA = 0.0f;
      cascadeVelocityStictionActive = false;
      Console.printf("OK cascade_velocity kp=%.6f ki=%.6f max_current=%.3fA friction=%.3fA current_slew=%.2fA/s brake_slew_x=%.1f hz=200\n",
                    kp, ki, maxCurrent, friction, currentSlew,
                    brakeSlewMultiplier);
    } else if (rest.startsWith("low_speed_current ")) {
      float currentA = 0.0f;
      if (sscanf(rest.c_str(), "low_speed_current %f", &currentA) != 1 ||
          !isfinite(currentA) || currentA < 0.0f || currentA > 7.0f) {
        Console.println("ERR usage: cascade low_speed_current CURRENT_A(0..7)");
        return;
      }
      cascadePositionLowSpeedCurrentA = currentA;
      Console.printf("OK cascade_low_speed_current=%.3fA (position mode, <=1r/s)\n",
                    cascadePositionLowSpeedCurrentA);
    } else if (rest.startsWith("breakaway ")) {
      float pulseCurrent = 0.0f, pulseMs = 0.0f;
      float retryMs = 0.0f, speedDps = 0.0f;
      float rampAps = cascadeBreakawayRampAps;
      const int parsed = sscanf(rest.c_str(), "breakaway %f %f %f %f %f",
                                &pulseCurrent, &pulseMs, &retryMs, &speedDps,
                                &rampAps);
      if ((parsed != 4 && parsed != 5) ||
          !isfinite(pulseCurrent) || !isfinite(pulseMs) ||
          !isfinite(retryMs) || !isfinite(speedDps) || !isfinite(rampAps) ||
          pulseCurrent < 0.0f || pulseCurrent > 5.0f ||
          pulseMs < 1.0f || pulseMs > 500.0f ||
          retryMs < 5.0f || retryMs > 1000.0f ||
          speedDps < 1.0f || speedDps > 500.0f ||
          rampAps < 0.1f || rampAps > 400.0f) {
        Console.println("ERR usage: cascade breakaway CURRENT_A(0..5) MAX_MS(1..500) RETRY_MS(5..1000) SPEED_DPS(1..500) [RAMP_A_PER_S(0.1..400)]");
        return;
      }
      cascadeBreakawayPulseCurrentA = pulseCurrent;
      cascadeBreakawayPulseMs = pulseMs;
      cascadeBreakawayRetryMs = retryMs;
      cascadeBreakawayPulseSpeedDps = speedDps;
      cascadeBreakawayRampAps = rampAps;
      cascadeBreakawayPulseActive = false;
      cascadeBreakawayFeedForwardA = 0.0f;
      cascadeBreakawayLastAttemptUs = 0;
      cascadeBreakawayPulseReleasePending = false;
      Console.printf("OK cascade_breakaway current=%.3fA max=%.1fms retry=%.1fms speed=%.1fdeg/s ramp=%.1fA/s\n",
                    pulseCurrent, pulseMs, retryMs, speedDps, rampAps);
    } else if (rest.startsWith("position ")) {
      float kp = 0.0f, ki = 0.0f, kd = 0.0f, maxVelocity = 0.0f;
      float deadband = 0.0f, minVelocity = cascadePositionMinVelocityDps;
      float acceleration = cascadePositionMaxAccelerationDps2;
      float reverseKdScale = cascadePositionReverseKdScale;
      const int parsed = sscanf(rest.c_str(), "position %f %f %f %f %f %f %f %f",
                                &kp, &ki, &kd, &maxVelocity, &deadband, &minVelocity,
                                &acceleration, &reverseKdScale);
      if ((parsed < 5 || parsed > 8) || !isfinite(kp) || !isfinite(ki) ||
          !isfinite(kd) || !isfinite(maxVelocity) || !isfinite(deadband) ||
          !isfinite(minVelocity) || !isfinite(acceleration) ||
          !isfinite(reverseKdScale) ||
          kp < 0.0f || kp > 1000.0f || ki < 0.0f || ki > 1000.0f ||
          kd < 0.0f || kd > 100.0f || maxVelocity < 1.0f ||
          maxVelocity > 60000.0f || deadband < 0.0f || deadband > 360.0f ||
          minVelocity < 0.0f || minVelocity > maxVelocity ||
          acceleration < 1.0f || acceleration > 100000.0f ||
          reverseKdScale < 0.1f || reverseKdScale > 5.0f) {
        Console.println("ERR usage: cascade position KP KI KD MAX_VELOCITY_DPS DEADBAND_DEG [MIN_VELOCITY_DPS] [ACCELERATION_DPS2] [REVERSE_KD_SCALE]");
        return;
      }
      cascadePositionKp = kp; cascadePositionKi = ki; cascadePositionKd = kd;
      cascadePositionMaxVelocityDps = maxVelocity;
      cascadePositionMinVelocityDps = minVelocity;
      cascadePositionMaxAccelerationDps2 = acceleration;
      cascadePositionReverseKdScale = reverseKdScale;
      cascadePositionDeadbandDeg = deadband; cascadePositionIntegral = 0.0f;
      cascadePositionSettled = false;
      Console.printf("OK cascade_position kp=%.3f ki=%.3f kd=%.3f reverse_kd_scale=%.2f max_velocity=%.1f min_velocity=%.1f acceleration=%.1f deadband=%.2f position_velocity_hz=500 position_hz=200\n",
                    kp, ki, kd, reverseKdScale, maxVelocity, minVelocity,
                    acceleration, deadband);
    } else if (rest.startsWith("trajectory ")) {
      float maxVelocity = 0.0f, acceleration = 0.0f;
      float jerk = 0.0f, bandwidth = 0.0f;
      if (sscanf(rest.c_str(), "trajectory %f %f %f %f",
                 &maxVelocity, &acceleration, &jerk, &bandwidth) != 4 ||
          !isfinite(maxVelocity) || !isfinite(acceleration) ||
          !isfinite(jerk) || !isfinite(bandwidth) ||
          maxVelocity < 1.0f || maxVelocity > 60000.0f ||
          acceleration < 1.0f || acceleration > 100000.0f ||
          jerk < 10.0f || jerk > 1000000.0f ||
          bandwidth < 0.2f || bandwidth > 20.0f) {
        Console.println("ERR usage: cascade trajectory MAX_DPS ACCEL_DPS2 JERK_DPS3 BANDWIDTH_RAD_S");
        return;
      }
      cascadePositionMaxVelocityDps = maxVelocity;
      cascadePositionMaxAccelerationDps2 = acceleration;
      cascadePositionMaxJerkDps3 = jerk;
      cascadeTrajectoryBandwidthRadS = bandwidth;
      Console.printf("OK cascade_trajectory max_velocity=%.1f acceleration=%.1f jerk=%.1f bandwidth=%.2f\n",
                    maxVelocity, acceleration, jerk, bandwidth);
    } else {
      Console.println("ERR usage: cascade status|current KP KI MAX_PWM|velocity KP KI MAX_A [FRICTION_A] [CURRENT_SLEW_A_PER_S] [BRAKE_SLEW_MULTIPLIER]|low_speed_current CURRENT_A|position KP KI KD MAX_DPS DEAD [MIN_DPS] [ACCEL_DPS2]|trajectory MAX_DPS ACCEL_DPS2 JERK_DPS3 BANDWIDTH|breakaway CURRENT_A MAX_MS RETRY_MS SPEED_DPS [RAMP_A_PER_S]");
    }
  } else if (op == "sensepolarity" || op == "currentpolarity") {
    if (rest != "normal" && rest != "invert") {
      Console.println("ERR usage: sensepolarity normal|invert");
      return;
    }
    currentSensePolarity = rest == "invert" ? -1 : 1;
    saveMotorModel();
    resetCascadeController();
    Console.printf("OK sensepolarity=%s sign=%d\n", rest.c_str(),
                  static_cast<int>(currentSensePolarity));
  } else if (op == "pospid" || op == "position_pid" || op == "pidpos") {
    if (rest == "on") {
      positionPidEnabled = true;
      positionPidIntegral = 0.0f;
      positionPidPulseAccumulator = 0.0f;
      Console.println("OK pospid=on");
    } else if (rest == "off") {
      positionPidEnabled = false;
      positionPidIntegral = 0.0f;
      Console.println("OK pospid=off");
    } else if (rest == "status") {
      Console.printf("POSPID enabled=%d kp=%.6fPWM/deg ki=%.6fPWM/(deg*s) kd=%.6fPWM/(deg/s) max_pwm=%.0f i_limit=%.3fdeg*s deadband=%.3fdeg min_pwm=%.0f integral=%.3fdeg*s\n",
                    positionPidEnabled ? 1 : 0, positionPidKp, positionPidKi,
                    positionPidKd, positionPidMaxPwm,
                    positionPidIntegralLimit, positionPidDeadbandDeg, positionPidMinPwm,
                    positionPidIntegral);
    } else if (rest.startsWith("set ")) {
      float kp = 0.0f, ki = 0.0f, kd = 0.0f, maxPwm = 0.0f;
      float integralLimit = 0.0f, deadband = 0.0f, minPwm = positionPidMinPwm;
      const int parsed = sscanf(rest.c_str(), "set %f %f %f %f %f %f %f", &kp, &ki, &kd,
                                &maxPwm, &integralLimit, &deadband, &minPwm);
      if ((parsed != 6 && parsed != 7) ||
          !isfinite(kp) || !isfinite(ki) || !isfinite(kd) ||
          !isfinite(maxPwm) || !isfinite(integralLimit) ||
          !isfinite(deadband) || kp < 0.0f || kp > 1000.0f ||
          ki < 0.0f || ki > 1000.0f || kd < 0.0f || kd > 100.0f ||
          maxPwm < 1.0f || maxPwm > static_cast<float>(PWM_MAX) ||
          integralLimit < 0.0f || integralLimit > 100000.0f ||
          deadband < 0.0f || deadband > 36000.0f ||
          minPwm < 0.0f || minPwm > maxPwm) {
        Console.println("ERR usage: pospid set KP KI KD MAX_PWM I_LIMIT DEADBAND [MIN_PWM]");
        return;
      }
      positionPidKp = kp;
      positionPidKi = ki;
      positionPidKd = kd;
      positionPidMaxPwm = maxPwm;
      positionPidIntegralLimit = integralLimit;
      positionPidDeadbandDeg = deadband;
      positionPidMinPwm = minPwm;
      positionPidIntegral = 0.0f;
      Console.printf("OK pospid kp=%.6f ki=%.6f kd=%.6f max_pwm=%.0f i_limit=%.3fdeg*s deadband=%.3fdeg min_pwm=%.0f\n",
                    positionPidKp, positionPidKi, positionPidKd,
                    positionPidMaxPwm, positionPidIntegralLimit,
                    positionPidDeadbandDeg, positionPidMinPwm);
    } else {
      Console.println("ERR usage: pospid on|off|status|set KP KI KD MAX_PWM I_LIMIT DEADBAND [MIN_PWM]");
    }
  } else if (op == "encoder") {
    uint16_t raw = 0; float deg = 0;
    if (readEncoder(raw, deg)) Console.printf("ENCODER ok raw=%u single=%.3fdeg multi=%.3fdeg addr=0x%02X\n", raw, deg, encoderMultiTurnDegrees, MT6701_ADDR);
    else Console.println("ENCODER ERR no ACK/data from 0x06");
  } else if (op == "encreset" || op == "encoder_reset") {
    if (rebaseEncoderMultiTurn()) Console.printf("OK encoder_rebase single=%.3fdeg multi=%.3fdeg\n", encoderLastSingleTurnDegrees, encoderMultiTurnDegrees);
    else Console.println("ERR encoder rebase failed");
  } else if (op == "rawadc") {
    float busMv = 0;
    const float busV = readBusVoltage(&busMv);
    const float currentRawMv = readCurrentSenseMillivolts();
    trackCurrentZeroAtIdle(currentRawMv);
    const float currentMv = filterCurrentSenseMillivolts(currentRawMv);
    Console.printf("ADC bus=%.0fmV bus_calc=%.3fV current_raw=%.0fmV current_filtered=%.0fmV signed=%.0fmA\n",
                  busMv, busV, currentRawMv, currentMv, readSignedCurrentMilliamps(currentMv));
  } else if (op == "businfo") {
    Console.printf("BUS addr=%u uid=%llX baud=%lu framing=B5 2B v1 CRC16 DATA=BUS_TX/BUS_RX transport=proven-hardware-serial crc_err=%lu resync=%lu uart_err=%lu rx_bytes=%lu valid=%lu addressed=%lu cmd_rx=%lu tx=%lu response_tx=%lu\n",
                  static_cast<unsigned>(busAddress),
                  static_cast<unsigned long long>(ESP.getEfuseMac()),
                  static_cast<unsigned long>(busBaudrate),
                  static_cast<unsigned long>(busCrcErrorCount),
                  static_cast<unsigned long>(busResyncCount),
                  static_cast<unsigned long>(busUartErrorCount),
                  static_cast<unsigned long>(busRxByteCount),
                  static_cast<unsigned long>(busValidFrameCount),
                  static_cast<unsigned long>(busAddressedFrameCount),
                  static_cast<unsigned long>(busCommandRxCount),
                  static_cast<unsigned long>(busFrameTxCount),
                  static_cast<unsigned long>(busResponseTxCount));
  } else if (op == "busbaud") {
    int requested = 0;
    if (!parseUInt(rest, requested) ||
        (requested != 115200 && requested != 250000 && requested != 500000 &&
         requested != 750000 && requested != 1000000)) {
      Console.println("ERR usage: busbaud 115200|250000|500000|750000|1000000");
      return;
    }
    busTransactionActive = false;
    syncMotionArmed = false;
    syncControlRunning = false;
    BusSerial.flush();
    BusSerial.updateBaudRate(static_cast<uint32_t>(requested));
    busBaudrate = static_cast<uint32_t>(requested);
    Console.printf("OK busbaud=%lu\n", static_cast<unsigned long>(busBaudrate));
  } else if (op == "busaddr") {
    int address = 0;
    if (!parseUInt(rest, address) || address < 1 || address > 254) {
      Console.println("ERR usage: busaddr 1..254");
      return;
    }
    Console.println(saveBusAddress(static_cast<uint8_t>(address))
                      ? String("OK busaddr=") + String(busAddress)
                      : String("ERR busaddr save failed"));
  } else if (op == "bus") {
    const int split = rest.indexOf(' ');
    if (split < 0) {
      Console.println("ERR usage: bus ADDR|all ping|status|arm|disarm|wake|sleep|stop|pos...|velocity...|current...");
      return;
    }
    const String destinationText = rest.substring(0, split);
    const String busCommand = rest.substring(split + 1);
    uint8_t destination = 0;
    if (destinationText == "all") {
      destination = BUS_BROADCAST;
      if (busCommand != "stop") {
        Console.println("ERR broadcast only supports stop");
        return;
      }
    } else {
      int parsedAddress = 0;
      if (!parseUInt(destinationText, parsedAddress) || parsedAddress < 1 || parsedAddress > 254) {
        Console.println("ERR bus address must be 1..254 or all");
        return;
      }
      destination = static_cast<uint8_t>(parsedAddress);
    }
    if (busCommand.length() == 0 || busCommand.length() > BUS_MAX_PAYLOAD) {
      Console.println("ERR empty or oversized bus command");
      return;
    }
    const uint8_t sequence = ++busSequence;
    busStartTransaction(destination, sequence, busCommand);
    Console.printf("OK bus_tx dest=%s seq=%u command=%s\n", destinationText.c_str(),
                  static_cast<unsigned>(sequence), busCommand.c_str());
  } else if (op == "sync") {
    if (rest == "off" || rest == "stop") {
      syncMotionArmed = false;
      syncMode = SYNC_OFF;
      syncPeerAddress = 0;
      motorStop();
      syncResetLinkCounters();
      Console.println("OK sync=off pwm=0");
    } else if (rest == "disarm") {
      motorStop();
      syncResetLinkCounters();
      Console.println("OK sync_disarmed pwm=0");
    } else if (rest == "arm") {
      if (syncMode == SYNC_OFF || syncPeerAddress == 0) {
        Console.println("ERR sync is not configured");
        return;
      }
      if (!driverAwake) {
        Console.println("ERR driver sleeping; run wake first");
        return;
      }
      if (digitalRead(PIN_NFAULT) == LOW) {
        Console.println("ERR nFAULT low");
        return;
      }
      syncMotionArmed = true;
      syncResetLinkCounters();
      Console.printf("OK sync_armed mode=%s peer=%u leader=%d period=%luus\n",
                    syncModeName(), static_cast<unsigned>(syncPeerAddress),
                    busAddress < syncPeerAddress ? 1 : 0,
                    static_cast<unsigned long>(SYNC_PERIOD_US));
    } else if (rest == "status") {
      const uint32_t ageUs = syncLastRxUs == 0 ? 0 : micros() - syncLastRxUs;
      Console.printf("SYNC mode=%s peer=%u armed=%d leader=%d period=%luus age=%luus tx=%lu(%lu/%lu) rx=%lu(%lu/%lu) timeout=%lu offset=%.2f remote_pos=%.2f remote_cmd=%.2f remote_vel=%.1f remote_current=%.0fmA\n",
                    syncModeName(), static_cast<unsigned>(syncPeerAddress),
                    syncMotionArmed ? 1 : 0,
                    syncPeerAddress != 0 && busAddress < syncPeerAddress ? 1 : 0,
                    static_cast<unsigned long>(SYNC_PERIOD_US),
                    static_cast<unsigned long>(ageUs),
                    static_cast<unsigned long>(syncTxCount),
                    static_cast<unsigned long>(syncRequestTxCount),
                    static_cast<unsigned long>(syncResponseTxCount),
                    static_cast<unsigned long>(syncRxCount),
                    static_cast<unsigned long>(syncRequestRxCount),
                    static_cast<unsigned long>(syncResponseRxCount),
                    static_cast<unsigned long>(syncTimeoutCount),
                    syncPositionOffsetDeg,
                    syncRemotePositionDeg, syncRemoteCommandPositionDeg,
                    syncRemoteVelocityDps,
                    syncRemoteCurrentMa);
    } else if (rest.startsWith("position ")) {
      int peer = 0, duty = 0, timeout = 0;
      float offset = 0.0f;
      if (sscanf(rest.c_str(), "position %d %f %d %d", &peer, &offset, &duty, &timeout) != 4 ||
          peer < 1 || peer > 254 || peer == busAddress || !isfinite(offset) ||
          fabsf(offset) > 36000.0f || duty < 12 || duty > TEST_DUTY_MAX ||
          timeout < 100 || timeout > 30000) {
        Console.println("ERR usage: sync position PEER OFFSET_DEG MAX_DUTY TIMEOUT_MS");
        return;
      }
      syncMotionArmed = false;
      motorStop();
      syncMode = SYNC_POSITION;
      syncPeerAddress = static_cast<uint8_t>(peer);
      syncPositionOffsetDeg = offset;
      syncMaxDuty = static_cast<uint16_t>(duty);
      syncTimeoutMs = static_cast<uint32_t>(timeout);
      syncResetLinkCounters();
      syncMotionArmed = true;
      Console.printf("OK sync_config mode=position peer=%u offset=%.3f duty=%u timeout=%lu\n",
                    static_cast<unsigned>(syncPeerAddress), syncPositionOffsetDeg,
                    static_cast<unsigned>(syncMaxDuty),
                    static_cast<unsigned long>(syncTimeoutMs));
    } else if (rest.startsWith("force ")) {
      int peer = 0, duty = 0, timeout = 0;
      float stiffness = 0.0f, damping = 0.0f, reflection = 0.0f, limit = 0.0f;
      float offset = 0.0f;
      const int parsed = sscanf(rest.c_str(), "force %d %f %f %f %f %d %d %f",
                                &peer, &stiffness, &damping, &reflection,
                                &limit, &duty, &timeout, &offset);
      if ((parsed != 7 && parsed != 8) ||
          peer < 1 || peer > 254 || peer == busAddress || !isfinite(stiffness) ||
          !isfinite(damping) || !isfinite(reflection) || !isfinite(limit) || !isfinite(offset) ||
          stiffness < 0.0f || stiffness > 1000.0f || damping < 0.0f ||
          damping > 1000.0f || reflection < 0.0f || reflection > 4.0f ||
          limit < 10.0f || limit > 4500.0f || fabsf(offset) > 360.0f ||
          duty < 12 || duty > TEST_DUTY_MAX ||
          timeout < 100 || timeout > 30000) {
        Console.println("ERR usage: sync force PEER KP_MA_PER_DEG KD_MA_PER_DPS REFLECT_GAIN LIMIT_MA MAX_DUTY TIMEOUT_MS [OFFSET_DEG]");
        return;
      }
      motorStop();
      syncMode = SYNC_FORCE;
      syncPeerAddress = static_cast<uint8_t>(peer);
      syncStiffnessMaPerDeg = stiffness;
      syncDampingMaPerDps = damping;
      syncReflectionGain = reflection;
      syncCurrentLimitMa = limit;
      syncPositionOffsetDeg = offset;
      syncMaxDuty = static_cast<uint16_t>(duty);
      syncTimeoutMs = static_cast<uint32_t>(timeout);
      syncResetLinkCounters();
      syncMotionArmed = true;
      Console.printf("OK sync_config mode=force peer=%u kp=%.3f kd=%.3f reflect=%.3f limit=%.0fmA duty=%u timeout=%lu offset=%.2f\n",
                    static_cast<unsigned>(syncPeerAddress), syncStiffnessMaPerDeg,
                    syncDampingMaPerDps, syncReflectionGain, syncCurrentLimitMa,
                    static_cast<unsigned>(syncMaxDuty),
                    static_cast<unsigned long>(syncTimeoutMs), syncPositionOffsetDeg);
    } else {
      Console.println("ERR usage: sync off|stop|disarm|arm|status|position PEER OFFSET_DEG MAX_DUTY TIMEOUT_MS|force PEER KP_MA_PER_DEG KD_MA_PER_DPS REFLECT_GAIN LIMIT_MA MAX_DUTY TIMEOUT_MS [OFFSET_DEG]");
    }
  } else if (op == "model") {
    Console.printf("MODEL fw=%s enabled=%d identify=%d direction=%s sense=%s R=%.5fOhm Ke=%.6fV/(rad/s) accel_per_A=%.2f(rad/s2)/A friction=%.4f samples=%lu/%lu\n",
                  FW_VERSION,
                  modelControlActive ? 1 : 0, modelIdentificationEnabled ? 1 : 0,
                  modelDirectionSign < 0 ? "invert" : "normal",
                  currentSensePolarity < 0 ? "invert" : "normal",
                  modelResistanceOhm, modelKeVoltSecondsPerRad, mechanicalTheta[0], mechanicalTheta[1],
                  static_cast<unsigned long>(modelElectricalSamples), static_cast<unsigned long>(modelMechanicalSamples));
  } else if (op == "direction") {
    if (rest == "normal") modelDirectionSign = 1;
    else if (rest == "invert") modelDirectionSign = -1;
    else {
      Console.println("ERR usage: direction normal|invert");
      return;
    }
    motorStop();
    saveMotorModel();
    Console.printf("OK direction=%s pwm=0\n", modelDirectionSign < 0 ? "invert" : "normal");
  } else if (op == "identify") {
    if (rest == "on") {
      modelIdentificationEnabled = true;
      controlMode = CONTROL_IDENTIFY;
      Console.println("OK identify=on; excite the motor with current/velocity commands to fit R, Ke and mechanical ratios");
    } else if (rest == "start") {
      if (!driverAwake) { Console.println("ERR driver sleeping; run wake first"); return; }
      if (digitalRead(PIN_NFAULT) == LOW) { Console.println("ERR nFAULT low"); return; }
      if (readBusVoltage() < 2.0f) { Console.println("ERR bus_low; check motor supply"); return; }
      resetMotorModel();
      setCurrentStep(3);
      modelIdentificationEnabled = true;
      modelControlActive = false;
      controlMode = CONTROL_IDENTIFY;
      identificationRunActive = true;
      identificationPhase = 0;
      identificationPhaseUntilMs = 0;
      Console.println("OK identify=start; bounded excitation 2.25s; STOP aborts");
    } else if (rest == "off") {
      modelIdentificationEnabled = false;
      if (!modelControlActive) controlMode = CONTROL_IDLE;
      Console.println("OK identify=off");
    } else if (rest == "reset") {
      resetMotorModel();
      saveMotorModel();
      Console.println("OK model reset; default model restored");
    } else {
      Console.println("ERR usage: identify on|off|reset|start");
    }
  } else if (op == "current" || op == "velocity" || op == "vel") {
    float target = 0.0f;
    int duty = 0, timeout = 0;
    if (sscanf(rest.c_str(), "%f %d %d", &target, &duty, &timeout) != 3 ||
        !isfinite(target) || duty < 12 || duty > TEST_DUTY_MAX || timeout < 100 || timeout > 30000) {
      Console.println("ERR usage: current mA D MS | velocity DPS D MS");
      return;
    }
    if (!driverAwake) { Console.println("ERR driver sleeping; run wake first"); return; }
    if (digitalRead(PIN_NFAULT) == LOW) { Console.println("ERR nFAULT low"); return; }
    if (readBusVoltage() < 2.0f) { Console.println("ERR bus_low; check motor supply"); return; }
    setCurrentStep(3);
    const bool seamlessVelocityRetarget =
        op != "current" && modelControlActive &&
        controlMode == CONTROL_VELOCITY;
    const float previousVelocityTargetDps = modelTargetVelocityDps;
    if (!seamlessVelocityRetarget) {
      resetCascadeController();
    } else if (previousVelocityTargetDps * target < 0.0f) {
      // Preserve the live velocity command for ordinary slider changes. On a
      // direction reversal, discard only the learned velocity integral and
      // breakaway state; the existing command still ramps down and brakes
      // instead of teleporting through zero.
      cascadeVelocityIntegral = 0.0f;
      cascadeVelocityBreakawayA = 0.0f;
      cascadeVelocityStictionActive = false;
      cascadeBreakawayPulseActive = false;
      cascadeBreakawayFeedForwardA = 0.0f;
      cascadeBreakawayPulseReleasePending = true;
    }
    modelControlActive = true;
    controlMode = op == "current" ? CONTROL_CURRENT : CONTROL_VELOCITY;
    modelTargetCurrentAmps = op == "current" ? constrain(target / 1000.0f, -modelCurrentLimitAmps, modelCurrentLimitAmps) : 0.0f;
    modelTargetVelocityDps = op == "current" ? 0.0f : constrain(target, -modelMaxVelocityDps, modelMaxVelocityDps);
    // An enabled position PID is a hold mode: keep evaluating the outer loop
    // after the first arrival so a later disturbance is corrected back to the
    // target. STOP remains the explicit way to leave this mode.
    modelStopAtMs = millis() + static_cast<uint32_t>(timeout);
    modelMaxDuty = static_cast<uint16_t>(duty);
    if (!seamlessVelocityRetarget) {
      lastModelTickMs = 0;
      modelPreviousSampleUs = 0;
    }
    modelCurrentIntegral = 0.0f;
    modelVelocityIntegral = 0.0f;
    modelStartBoostUntilMs = !seamlessVelocityRetarget && op == "velocity"
                                 ? millis() + 25 : 0;
    Console.printf("OK model_%s target=%.3f%s max_duty=%u timeout=%dms identify=%d\n",
                  controlMode == CONTROL_CURRENT ? "current" : "velocity", target,
                  controlMode == CONTROL_CURRENT ? "A*1000" : "deg/s",
                  static_cast<unsigned>(modelMaxDuty), timeout, modelIdentificationEnabled ? 1 : 0);
  } else if (op == "stream") {
    if (rest == "off") {
      streamEnabled = false;
      Console.println("OK stream=off");
      return;
    }
    int rate = 0;
    if (!parseUInt(rest, rate) || rate < 1 || rate > 100) {
      Console.println("ERR usage: stream 1..100|off");
      return;
    }
    streamRateHz = static_cast<uint16_t>(rate);
    streamEnabled = true;
    nextStreamAtUs = micros();
    Console.printf("OK stream=%uHz\n", static_cast<unsigned>(streamRateHz));
  } else if (op == "recover") {
    motorStop();
    if (digitalRead(PIN_NFAULT) == LOW) {
      Console.println("ERR recover blocked: nFAULT=0");
      return;
    }
    const float recoverBusVoltage = readBusVoltage();
    if (recoverBusVoltage < 6.0f) {
      Console.printf("ERR recover blocked: bus_low=%.2fV\n", recoverBusVoltage);
      return;
    }
    // A driver may stop switching after a transient while nFAULT has already
    // returned high. An idempotent WAKE would only rewrite two HIGH levels and
    // leave that internal state untouched. RECOVER is deliberately stronger:
    // force nSLEEP/nRESET low, run the complete wake sequence, and rebuild the
    // LEDC mapping before clearing the software latch.
    setDriverAwake(false);
    delay(2);
    setDriverAwake(true);
    configurePwmHardware();
    powerPathFaultLatched = false;
    Console.printf("OK recovered power_path_fault=0 bus=%.2fV pwm=0\n",
                   recoverBusVoltage);
  } else if (op == "wake") {
    const bool resetPerformed = !driverAwake;
    setDriverAwake(true);
    Console.printf("OK driver_awake=1 pwm=%u reset=%d\n",
                   static_cast<unsigned>(pwmDuty()),
                   resetPerformed ? 1 : 0);
  } else if (op == "sleep") {
    setDriverAwake(false);
    Console.println("OK driver_awake=0 pwm=0");
  } else if (op == "stop") {
    motorStop();
    Console.println("OK stop");
  } else if (op == "setstep") {
    int step = -1;
    if (!parseUInt(rest, step) || step < 0 || step > 3) {
      Console.println("ERR usage: setstep 0|1|2|3");
      return;
    }
    digitalWrite(PIN_I0, step & 1 ? HIGH : LOW);
    digitalWrite(PIN_I1, step & 2 ? HIGH : LOW);
    currentStep = static_cast<uint8_t>(step);
    Console.printf("OK step=%d I0=%d I1=%d\n", step, step & 1 ? 1 : 0, step & 2 ? 1 : 0);
  } else if (op == "decay") {
    if (rest == "slow") { digitalWrite(PIN_DECAY, LOW); Console.println("OK decay=slow"); }
    else if (rest == "fast") { digitalWrite(PIN_DECAY, HIGH); Console.println("OK decay=fast"); }
    else Console.println("ERR usage: decay slow|fast");
  } else if (op == "led") {
    if (rest == "on") { digitalWrite(PIN_LED, HIGH); Console.println("OK led=on"); }
    else if (rest == "off") { digitalWrite(PIN_LED, LOW); Console.println("OK led=off"); }
    else Console.println("ERR usage: led on|off");
  } else if (op == "pos") {
    float target = 0.0f;
    int duty = 0, timeout = 0;
    if (sscanf(rest.c_str(), "%f %d %d", &target, &duty, &timeout) != 3 ||
        !isfinite(target) || fabsf(target) > POSITION_COMMAND_MAX_DEG ||
        duty < 12 || duty > TEST_DUTY_MAX || timeout < 100 || timeout > 30000) {
      Console.println("ERR usage: pos target_deg(-36000..36000) duty(12..4095) timeout_ms(100..30000)");
      return;
    }
    if (!driverAwake) { Console.println("ERR driver sleeping; run wake first"); return; }
    if (digitalRead(PIN_NFAULT) == LOW) { Console.println("ERR nFAULT low"); return; }
    const float busV = readBusVoltage();
    if (busV < 2.0f) {
      Console.printf("ERR bus_low=%.2fV; check motor supply and ground\n", busV);
      return;
    }
    setCurrentStep(3);
    const bool seamlessRetarget = modelControlActive &&
                                  controlMode == CONTROL_POSITION &&
                                  !cascadePositionReleased;
    const float oldError = modelTargetPositionDegrees -
                           encoderMultiTurnDegrees;
    const float newError = target - encoderMultiTurnDegrees;
    if (!seamlessRetarget) {
      resetCascadeController();
    } else {
      cascadePositionIntegral = 0.0f;
      cascadePositionSettled = false;
      // A live target update invalidates any old-direction breakaway pulse.
      // Release it before accepting the new target so a slider reversal can
      // never inherit a stale torque impulse.
      cascadeBreakawayPulseActive = false;
      cascadeBreakawayFeedForwardA = 0.0f;
      cascadeBreakawayPulseReleasePending = true;
      cascadeBreakawayDirectionSign = newError >= 0.0f ? 1 : -1;
      // Preserve trajectory velocity for same-direction slider updates. For a
      // reversal, discard learned torque so the current command can cross zero
      // immediately instead of briefly accelerating toward the old target.
      if (oldError * newError <= 0.0f) {
        cascadeVelocityIntegral = 0.0f;
        cascadeBreakawayFeedForwardA = 0.0f;
        cascadeVelocityBreakawayA = 0.0f;
        cascadeVelocityStictionActive = false;
      }
    }
    modelTargetPositionDegrees = target;
    cascadePositionReleased = false;
    modelTargetVelocityDps = 0.0f;
    modelTargetCurrentAmps = 0.0f;
    modelMaxDuty = static_cast<uint16_t>(duty);
    modelStopAtMs = millis() + static_cast<uint32_t>(timeout);
    modelControlActive = true;
    controlMode = CONTROL_POSITION;
    if (!seamlessRetarget) {
      lastModelTickMs = 0;
      modelPreviousSampleUs = 0;
      modelCurrentIntegral = 0.0f;
      modelVelocityIntegral = 0.0f;
      positionPidIntegral = 0.0f;
      positionPidSettled = false;
      modelStartBoostUntilMs = millis() + 20;
    }
    positionActive = false;
    stopAtMs = 0;
    Console.printf("OK model_position target=%.2f max_duty=%u timeout=%dms identify=%d retarget=%d\n",
                  modelTargetPositionDegrees, static_cast<unsigned>(modelMaxDuty), timeout,
                  modelIdentificationEnabled ? 1 : 0,
                  seamlessRetarget ? 1 : 0);
  } else if (op == "cw" || op == "ccw") {
    int duty = 0, duration = 0;
    const int split = rest.indexOf(' ');
    if (split < 0 || !parseUInt(rest.substring(0, split), duty) || !parseUInt(rest.substring(split + 1), duration) ||
        duty < 0 || duty > TEST_DUTY_MAX || duration < 1 || duration > static_cast<int>(TEST_TIME_MAX_MS)) {
    Console.println("ERR usage: cw|ccw duty(0..4095) time_ms(1..1000)");
      return;
    }
    if (!driverAwake) {
      Console.println("ERR driver sleeping; run wake first");
      return;
    }
    if (digitalRead(PIN_NFAULT) == LOW) {
      Console.println("ERR nFAULT low; run sleep then inspect board before retry");
      return;
    }
    modelControlActive = false;
    controlMode = CONTROL_IDLE;
    if (currentStep == 0) {
      digitalWrite(PIN_I0, LOW);
      digitalWrite(PIN_I1, HIGH);
      currentStep = 2;
      Console.println("INFO step=2 (38%) selected for manual motion");
    }
    setModelPhase(op == "cw" ? 1.0f : -1.0f);
    setPwm(static_cast<uint16_t>(duty));
    stopAtMs = millis() + static_cast<uint32_t>(duration);
    Console.printf("OK motion=%s duty=%d time=%dms\n", op.c_str(), duty, duration);
  } else {
    Console.println("ERR unknown command; type help");
  }
}

void setup() {
  // Configure safe output levels before enabling the driver.
  pinMode(PIN_ENBL, OUTPUT);   digitalWrite(PIN_ENBL, LOW);
  pinMode(PIN_PHASE, OUTPUT);  digitalWrite(PIN_PHASE, LOW);
  pinMode(PIN_NSLEEP, OUTPUT); digitalWrite(PIN_NSLEEP, LOW);
  pinMode(PIN_NRESET, OUTPUT); digitalWrite(PIN_NRESET, LOW);
  pinMode(PIN_DECAY, OUTPUT);  digitalWrite(PIN_DECAY, LOW);
  pinMode(PIN_I0, OUTPUT);     digitalWrite(PIN_I0, LOW);
  pinMode(PIN_I1, OUTPUT);     digitalWrite(PIN_I1, LOW);
  pinMode(PIN_NFAULT, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT);    digitalWrite(PIN_LED, LOW);

  // Bring up the native USB console before touching the encoder bus.  A
  // missing/stuck MT6701 must never leave a present USB CDC port unable to
  // accept STOP/diagnostic commands during setup.
  Serial.begin(115200);
  delay(250);
  Console.printf("\n%s %s\n", FW_NAME, FW_VERSION);
  Console.println("BOOT: USB console ready; driver still disabled");

  analogReadResolution(12);
  analogSetPinAttenuation(PIN_VBAT_ADC, ADC_11db);
  analogSetPinAttenuation(PIN_CURRENT_ADC, ADC_11db);
  const bool pwmReady = configurePwmHardware();
  resetMotorModel();
  loadMotorModel();
  calibrateCurrentZero();

  // MT6701 supports fast I2C operation; 1 MHz leaves enough margin for a
  // 500 Hz position-mode sample while the 100 Hz USB stream remains separate.
  Wire.begin(PIN_SDA, PIN_SCL, 1000000);
  // Never let an encoder wiring fault block setup/loop and starve USB CDC.
  // The normal transaction is sub-millisecond at 1 MHz; 3 ms is enough for
  // a valid read while keeping the console responsive when SDA/SCL is stuck.
  Wire.setTimeOut(3);
  bool bootEncoderZeroed = false;
  for (uint8_t attempt = 0; attempt < 5 && !bootEncoderZeroed; ++attempt) {
    bootEncoderZeroed = rebaseEncoderMultiTurn();
    if (!bootEncoderZeroed) delay(10);
  }
  // BUS_TX/BUS_RX is the board's auto-direction single-wire bus console.
  // It is not the ESP32 ROM download port; flashing is done over native USB.
  BusSerial.begin(busBaudrate, SERIAL_8N1, PIN_BUS_RX, PIN_BUS_TX);
  loadBusAddress();
  Console.println("SAFE: driver asleep, PWM=0, I0=0, I1=0");
  Console.printf("PWM init=%d requested=%luHz actual=%.0fHz resolution=%ubit max=%u\n",
                pwmReady ? 1 : 0, static_cast<unsigned long>(PWM_HZ),
                pwmConfiguredHz, static_cast<unsigned>(PWM_BITS),
                static_cast<unsigned>(PWM_MAX));
  Console.printf("ENCODER boot_zero=%d multi=%.2f\n", bootEncoderZeroed ? 1 : 0,
                encoderMultiTurnDegrees);
  printHelp();
  printStatus();
}

void loop() {
  // Consume the real-time DATA frame before the control tick so a fresh
  // remote state is used by the same iteration. The old 2 ms delay made the
  // ASCII bridge look responsive but added an avoidable control-cycle floor.
  busProcessRx();
  // Closed-loop/identification ticks own the encoder sample. Sampling once in
  // encoderTrackingTick and again immediately in the controller would feed a
  // near-zero delta into the velocity filter and make a moving rotor appear
  // stationary to the velocity/position loops.
  if (!positionActive && !modelControlActive && !identificationRunActive) encoderTrackingTick();
  if (identificationRunActive) identificationTick();
  else if (modelControlActive) cascadeControlTick();
  else positionControlTick();
  streamTick();
  if (stopAtMs != 0 && static_cast<int32_t>(millis() - stopAtMs) >= 0) {
    motorStop();
    Console.println("AUTO stop");
  }
  while (Serial.available()) {
    const char ch = static_cast<char>(Serial.read());
    if (ch == '\n' || ch == '\r') {
      handleCommand(line);
      line = String();
    } else if (line.length() < 100) {
      line += ch;
    }
  }
  busProcessRx();
  syncTick();
  busTransactionTick();
  delayMicroseconds(100);
}
