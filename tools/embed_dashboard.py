"""Build-time packaging of the actual desktop UI; no separate phone markup."""
import gzip
from pathlib import Path

if 'Import' in globals():
    Import('env')
    ROOT = Path(env.subst('$PROJECT_DIR')).resolve().parent
else:
    ROOT = Path(__file__).resolve().parents[1]
FILES = {'/': ('dashboard.html', 'text/html; charset=utf-8'),
         '/dashboard.js': ('dashboard.js', 'text/javascript; charset=utf-8'),
         '/dashboard.css': ('dashboard.css', 'text/css; charset=utf-8'),
         '/dashboard-cascade.css': ('dashboard-cascade.css', 'text/css; charset=utf-8'),
         '/gateway-transport.js': ('gateway-transport.js', 'text/javascript; charset=utf-8')}

def build():
    lines=['// Generated from web/ by tools/embed_dashboard.py. Do not edit.', '#pragma once', '#include <Arduino.h>',
           'struct DashboardAsset { const char *path; const char *mime; const uint8_t *data; size_t size; };']
    records=[]
    for i,(url,(name,mime)) in enumerate(FILES.items()):
        data=(ROOT/'web'/name).read_bytes()
        if name=='dashboard.html':
            data=data.replace(b'</head>',b'<script src="/gateway-config.js"></script></head>')
        packed=gzip.compress(data,mtime=0)
        lines.append(f'static const uint8_t dashboardAsset{i}[] PROGMEM={{'+','.join(map(str,packed))+'};')
        records.append(f'{{"{url}","{mime}",dashboardAsset{i},sizeof(dashboardAsset{i})}}')
    lines.append('static const DashboardAsset dashboardAssets[]={'+','.join(records)+'};')
    target=ROOT/'firmware/include/dashboard_assets.generated.h'
    content='\n'.join(lines)+'\n'
    if not target.exists() or target.read_text(encoding='utf-8')!=content:
        target.write_text(content,encoding='utf-8')

build()
