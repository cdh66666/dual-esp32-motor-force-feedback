"""Identity-checked native USB reflash. No motor-motion commands are issued.

Normally requires a responding application for STOP. An explicit recovery
option accepts only two fresh, advancing OFF telemetry frames when OUT fails.
This does NOT recover broken USB hardware/descriptor enumeration.
"""
import argparse
import importlib.util
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path
import serial
from serial.tools import list_ports


def project_esptool(core_dir=None):
    """Use the same installed tool package as the PlatformIO build/upload.

    Never fall back to the globally installed esptool: the project's Windows
    USB recovery path was validated with this package, not that module.
    """
    root = Path(core_dir or os.environ.get('PLATFORMIO_CORE_DIR') or
                (Path.home() / '.platformio'))
    entry = root / 'packages' / 'tool-esptoolpy' / 'esptool.py'
    if not entry.is_file():
        raise RuntimeError('Project PlatformIO esptool missing: ' + str(entry))
    return entry


def flash_layout(project):
    """Return the generated flash artifacts and both OTA app slots.

    The project uses the standard 16 MB ESP32-S3 OTA table: app0 at 0x10000
    and app1 at 0x340000.  PlatformIO's normal ``upload`` target only writes
    app0, while an existing otadata record may select app1 after reset.  Write
    the same verified image to both slots so a reflash cannot leave the board
    in ROM merely because the old OTA selector points at the other slot.
    """
    build = project / 'firmware' / '.pio' / 'build' / 'esp32-s3-devkitc-1'
    files = {
        'bootloader': build / 'bootloader.bin',
        'partitions': build / 'partitions.bin',
        'app': build / 'firmware.bin',
    }
    missing = [str(path) for path in files.values() if not path.is_file()]
    if missing:
        raise RuntimeError('PlatformIO flash artifact missing: ' + ', '.join(missing))
    return files


def verify_passive_off(health, before, after):
    """Fail closed: old/partial telemetry is not a substitute for power OFF."""
    age = health.get('sample_age_ms')
    if (not health.get('active') or not health.get('reader_alive') or
            not isinstance(age, (int, float)) or not 0 <= age <= 250):
        raise RuntimeError('No fresh telemetry proof of motor power OFF')
    session = before.get('session_id')
    if not session or after.get('session_id') != session:
        raise RuntimeError('Telemetry session changed during preflight')
    frames = []
    for payload in (before, after):
        rows = [r for r in payload.get('logs', []) if r.get('session_id') == session and
                r.get('direction') == 'rx' and r.get('text', '').startswith('S,')]
        if not rows: raise RuntimeError('No current-session sample frame')
        values = [float(v) for v in rows[-1]['text'].split(',')[1:]]
        if (len(values) < 13 or not all(math.isfinite(v) for v in values) or
                not 0 <= values[3] < 1 or values[5] != 0 or values[7] != 0):
            raise RuntimeError('Telemetry requires VM<1 V, PWM=0 and awake=0')
        frames.append(values)
    delta = frames[1][0] - frames[0][0]
    if delta < 0:
        raise RuntimeError('MCU restarted during preflight')
    if not 0 < delta <= 1000:
        raise RuntimeError('Telemetry is stale during preflight')
    return {'session_id':session, 'mcu_ms':[v[0] for v in frames],
            'bus_v':[v[3] for v in frames], 'pwm':0, 'awake':0}


ATTACHED_FLASH_HEADROOM = 1.05
SS6952T_VM_MAX_V = 50.0


def verify_flash_state(state, motor_leads_disconnected=False, attached_guarded=False,
                       rated_voltage=None):
    vm=re.search(r'\bbus=([\d.]+)V\b',state)
    voltage=float(vm.group(1)) if vm else float('nan')
    stopped=bool(re.search(r'\bawake=0\b',state) and re.search(r'\bpwm=0/',state))
    attached_max_voltage = None
    if attached_guarded:
        if (rated_voltage is None or not math.isfinite(rated_voltage) or
                rated_voltage < 8 or rated_voltage > SS6952T_VM_MAX_V):
            raise RuntimeError('Attached guarded preflight requires a valid motor rated_voltage profile')
        attached_max_voltage = min(rated_voltage * ATTACHED_FLASH_HEADROOM,
                                   SS6952T_VM_MAX_V)
        velocity=re.search(r'\bvelocity=([-\d.]+)deg/s',state)
        current=re.search(r'\bmotor_current=([-\d.]+)mA\b',state)
        if (not velocity or not math.isfinite(float(velocity.group(1))) or
                abs(float(velocity.group(1))) > 1 or 'control=idle' not in state or
                'nFAULT=1' not in state or not current or
                not math.isfinite(float(current.group(1))) or
                abs(float(current.group(1))) > 100):
            raise RuntimeError('Attached guarded preflight requires idle, stationary, |current|<=100mA, nFAULT=1')
        voltage_ok=8 <= voltage <= attached_max_voltage
    elif motor_leads_disconnected:
        voltage_ok=8 <= voltage <= 21
    else:
        voltage_ok=0 <= voltage < 1
    if not stopped or not voltage_ok:
        requirement = (f'8..{attached_max_voltage:.2f} V in attached-guarded mode '
                       f'(rated voltage {rated_voltage:.2f} V plus 5% headroom)' if attached_guarded else
                       '8..21 V for physically disconnected motor test' if motor_leads_disconnected else
                       'motor power OFF (<1 V)')
        raise RuntimeError(f'Preflight failed: requires awake=0 PWM=0 and {requirement}')
    return voltage


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', required=True)
    parser.add_argument('--serial', required=True, help='USB serial/MAC, with or without colons')
    parser.add_argument('--url', default='http://127.0.0.1:8766')
    parser.add_argument('--flash', action='store_true', help='without this flag, only inspect identity')
    parser.add_argument('--motor-leads-disconnected', action='store_true',
                        help='Isolated 20 V supply test ONLY: user has physically unplugged motor wires; not sensed by software')
    parser.add_argument('--allow-telemetry-preflight', action='store_true',
                        help='OUT-failure recovery only: still requires fresh advancing OFF telemetry')
    parser.add_argument('--attached-guarded', action='store_true',
                        help='Explicit user-authorized attached-motor powered flashing with physical enclosure; requires idle/zero PWM/nFAULT, |current|<=100mA, and bus <= motor rated voltage +5% (driver max 50V); reset transients are not certified')
    args=parser.parse_args()
    if args.attached_guarded and (args.motor_leads_disconnected or args.allow_telemetry_preflight):
        parser.error('Attached guarded mode cannot claim disconnected leads or use passive recovery')
    if args.motor_leads_disconnected and args.allow_telemetry_preflight:
        parser.error('Isolated powered test requires ACK; passive recovery is not allowed')
    normal=lambda text: (text or '').replace(':','').replace('-','').upper()
    identity=normal(args.serial)
    def matching():
        return [p for p in list_ports.comports() if p.vid==0x303A and normal(p.serial_number)==identity]
    selected=matching()
    if len(selected)!=1 or selected[0].device.upper()!=args.port.upper():
        raise RuntimeError('Port/USB identity mismatch; no reset or write performed')
    print('SELECTED',selected[0].device,selected[0].serial_number,selected[0].location,flush=True)
    if not args.flash: return
    for module in ('platformio',):
        if importlib.util.find_spec(module) is None:
            raise RuntimeError('Missing '+module+' in this Python runtime; no reset performed')
    project=Path(__file__).resolve().parents[1]
    def run(*command):
        if command[0] == 'esptool':
            argv = [sys.executable, str(project_esptool()), *command[1:]]
        else:
            argv = [sys.executable, '-m', *command]
        subprocess.run(argv,cwd=project/'firmware',check=True)
    def api(endpoint,body):
        req=urllib.request.Request(args.url+'/api/'+endpoint,data=json.dumps(body).encode(),
                                   headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req,timeout=5) as response: result=json.load(response)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(exc.read().decode('utf-8','replace')) from exc
        if not result.get('ok'): raise RuntimeError(result)
        return result
    def send(port,command):
        result=api('send',{'port':port,'command':command,'wait_ack':True})
        if not result.get('acknowledged'): raise RuntimeError('No board execution acknowledgement')
        print(result['reply'],flush=True)
        return result['reply']
    def get(endpoint):
        with urllib.request.urlopen(args.url+'/api/'+endpoint,timeout=5) as response:
            return json.load(response)
    # Compile before disturbing a running application; fail closed on errors.
    run('platformio','run','-e','esp32-s3-devkitc-1')
    artifacts = flash_layout(project)
    try:
        send(args.port,'stop'); send(args.port,'sync off'); send(args.port,'sleep')
        state=send(args.port,'status')
        rated_voltage=None
        if args.attached_guarded:
            profile=send(args.port,'motorprofile status')
            rated_match=re.search(r'\brated_voltage=([\d.]+)V\b',profile)
            if not rated_match: raise RuntimeError('Attached guarded preflight requires motor rated_voltage readback')
            rated_voltage=float(rated_match.group(1))
        voltage=verify_flash_state(state,args.motor_leads_disconnected,args.attached_guarded,
                                   rated_voltage=rated_voltage)
        if args.attached_guarded:
            print('ATTACHED_GUARDED user-authorized powered flashing; motor leads CONNECTED; enclosure per user; reset transients NOT measured',flush=True)
            time.sleep(.3)
            verify_flash_state(send(args.port,'status'),attached_guarded=True,
                               rated_voltage=rated_voltage)
        if args.motor_leads_disconnected:
            print('ISOLATED_POWERED_TEST motor wires physically unplugged per user; VM=',voltage,
                  '; NOT acceptance of attached-motor powered flashing',flush=True)
    except (RuntimeError, OSError) as exc:
        if not args.allow_telemetry_preflight: raise
        # This does not take a permission flag as proof of electrical state.
        # It cannot recover a silent board or permit a powered reset.
        print('ACK preflight failed:',exc,flush=True)
        before=get('logs?port='+args.port+'&since=0')
        # A timed-out OUT write can briefly delay the backend reader. Poll
        # for two genuinely advancing frames, never equate sleep with proof.
        deadline=time.monotonic()+3
        while True:
            time.sleep(.15)
            after=get('logs?port='+args.port+'&since=0')
            health=next((p for p in get('ports')['ports'] if p['port']==args.port),{})
            try:
                proof=verify_passive_off(health,before,after)
                break
            except RuntimeError as pending:
                if (str(pending) not in ('No fresh telemetry proof of motor power OFF',
                                        'Telemetry is stale during preflight') or
                        time.monotonic()>=deadline):
                    raise
                before=after
        print('VERIFIED_PASSIVE_OFF',json.dumps(proof),flush=True)
    selected=matching()
    if len(selected)!=1 or selected[0].device.upper()!=args.port.upper():
        raise RuntimeError('USB identity changed during build/preflight; no reset performed')
    # Hold ownership through the normal-to-ROM port change. An open dashboard
    # used to auto-connect COM18 between discovery and esptool, making the
    # download port appear unavailable. Backend rejects connect while held.
    api('maintenance',{'port':args.port,'enabled':True})
    time.sleep(.15)
    transport=serial.Serial()
    transport.port=args.port; transport.baudrate=1200
    transport.dtr=True; transport.rts=False
    try: transport.open()
    except serial.SerialException as exc:
        # Windows can report ERROR_GEN_FAILURE while CDC deliberately detaches.
        # That exception is NOT proof of success; verify the ROM identity below.
        print('1200-touch detach:',exc,flush=True)
    finally: transport.close()
    deadline=time.monotonic()+12
    while True:
        found=matching()
        if len(found)==1 and ':' in (found[0].serial_number or ''): break
        if time.monotonic()>deadline: raise RuntimeError('Matching ROM did not enumerate; stopped without flashing')
        time.sleep(.2)
    rom=found[0].device
    print('ROM',rom,found[0].serial_number,flush=True)
    api('maintenance',{'port':rom,'enabled':True})
    # Do not use PlatformIO's upload target here: it writes app0 only.  An
    # existing OTA selector can legally point at app1, leaving a perfectly
    # hashed app0 apparently "stuck" in ROM after reset.  Keep bootloader and
    # partition layout in sync and write the verified app to both OTA slots.
    run('esptool','--chip','esp32s3','--port',rom,'--before','no_reset',
        '--after','no_reset','write_flash','--flash_mode','dio',
        '--flash_freq','80m','--flash_size','16MB',
        '0x0',str(artifacts['bootloader']),
        '0x8000',str(artifacts['partitions']),
        '0x10000',str(artifacts['app']),
        '0x340000',str(artifacts['app']))
    # Native USB boards without an external USB-UART bridge may not wire
    # DTR/RTS to GPIO0/EN.  The ROM write/hash is still complete, but leaving
    # download mode then requires releasing BOOT and pulsing RST once.
    run('esptool','--chip','esp32s3','--port',rom,'--before','no_reset',
        '--after','hard_reset','run')
    deadline=time.monotonic()+15
    while True:
        found=matching()
        if len(found)==1 and ':' not in (found[0].serial_number or ''): break
        if time.monotonic()>deadline:
            raise RuntimeError('Flash/hash complete but application did not enumerate; '
                               'native USB may still be in ROM. Release BOOT and pulse RST, '
                               'then reconnect; no motion was requested')
        time.sleep(.2)
    port=found[0].device
    for held in {args.port,rom,port}:
        api('maintenance',{'port':held,'enabled':False})
    api('connect',{'port':port})
    # COM presence precedes setup completion. Only STOP is retried while
    # waiting for the application's real execution acknowledgement.
    ready_deadline=time.monotonic()+10
    while True:
        try:
            send(port,'stop')
            break
        except RuntimeError:
            if time.monotonic()>ready_deadline: raise
            time.sleep(.25)
    send(port,'sleep'); send(port,'model'); send(port,'cascade status')
    verify_flash_state(send(port,'status'),args.motor_leads_disconnected,args.attached_guarded,
                       rated_voltage=rated_voltage if args.attached_guarded else None)
    print('READY',port,'PWM=0; old motion is not resumed',flush=True)


if __name__=='__main__': main()
