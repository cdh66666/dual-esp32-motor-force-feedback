# Hardware control limits

## Current path

- External motor-branch measurement: INA240A1, gain 20 V/V, 10 mOhm shunt, therefore 0.2 V/A.
- INA240 midpoint reference: REF1 to GND and REF2 to 3.3 V, so zero current is nominally 1.65 V.
- SS6952T internal current regulation: VREF divider 16.5 kOhm / 10 kOhm gives about 1.245 V; 50 mOhm ISEN and `IFS=VREF/(5*Rsense)` give about 4.98 A full scale.
- Normal cascaded-loop current ceiling: 4.8 A.
- Commissioning command envelope: 7 A for short hardware-limit tests only; it does not bypass the approximately 4.98 A SS6952T regulation limit.

The measured motor-branch current is not equal to the bench supply average current under PWM. Compare them only after accounting for duty cycle, bus voltage, motor back-EMF and losses.

## Shared firmware, local calibration

Both boards use one firmware image and one controller implementation. Only these commissioning values may differ:

- motor direction sign;
- current-sense sign;
- encoder multi-turn zero;
- DATA bus address.

No COM number, USB serial number or MAC address selects controller gains.
