# Hardware control limits

## Current path

- External motor-branch measurement: INA240A1, gain 20 V/V, 10 mOhm shunt, therefore 0.2 V/A.
- SS6952T VM is the driver supply rail, not the motor's rated voltage; use an 8–50 V VM rail. A 6 V motor can be driven from that rail only by limiting its PWM/armature voltage.
- INA240 midpoint reference in the supplied U8 schematic: REF1 to 3.3 V and REF2 to GND, so zero current is nominally 1.65 V. Swapping these two reference connections also produces midsupply; this reference arrangement is not itself a wiring fault.
- SS6952T internal current regulation: VREF divider 16.5 kOhm / 10 kOhm gives about 1.245 V; 50 mOhm ISEN and `IFS=VREF/(5*Rsense)` give about 4.98 A full scale.
- Legacy 775 ceiling: 4.8 A. The 36GP-555 defaults are 0.6 A outer-loop ceiling and a 2 A software commissioning envelope, not certified motor ratings.
- Legacy 7 A diagnostic commands do not bypass board regulation and are not applicable to the new 36GP-555 motor. Driver supply range does not certify capacitor, connector, PCB or motor limits.

The measured motor-branch current is not equal to the bench supply average current under PWM. Compare them only after accounting for duty cycle, bus voltage, motor back-EMF and losses.

## 36GP-555 / 24 V geared motor

The supplied catalogue image states 24 V, 1538 rpm no-load speed, 1:5.2 reduction, 1.5 kgf.cm no-load torque and 15 W no-load power. It does not state stall current or a continuous winding-current rating. The firmware therefore starts this profile with a 2.0 A software commissioning envelope and keeps the driver VM requirement separate from the motor rated voltage. The MT6701 magnet is on the rear motor shaft: encoder-side angle/speed are the controller coordinates, while the gearbox output angle/speed are approximately encoder-side values divided by 5.2.

The 15 W / 24 V figure is an approximate no-load electrical-power context only; it must not be used as a stall-current limit. Use the bounded identification command and current/temperature observations before raising the outer-loop current ceiling.

## Shared firmware, local calibration

Both boards use one firmware image and one controller implementation. Only these commissioning values may differ:

- motor direction sign;
- current-sense sign;
- encoder multi-turn zero;
- DATA bus address.
- identified electrical R/Ke and mechanical coefficients;
- bounded raw-encoder-angle disturbance compensation for the particular motor/magnet assembly.

No COM number, USB serial number or MAC address selects controller gains.

The current 36GP implementation uses true 12-bit LEDC with an explicit 80 MHz APB clock, measured 19531 Hz carrier. A request for 12 bits/19531 Hz with the old automatic 40 MHz XTAL clock failed: check the actual `pwm_hz`, not just the configured constant. ADC calibration is cached rather than rebuilt per read. See the dated commissioning report for measured timing, jitter, and limitations.
