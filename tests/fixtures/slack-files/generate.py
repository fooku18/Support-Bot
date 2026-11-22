"""Reproducible non-secret fixture pixels and PDFs; facts are absent from filenames/prompts."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import zlib
root = Path(__file__).parent
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 36)
for name, text in [('panel', 'Sensor: KESTREL\nPressure: 73 kPa\nStatus: AMBER'), ('scan', 'Archive ledger\nLot: MARIGOLD\nUnits received: 417')]:
    im = Image.new('RGB', (900, 360), 'white')
    ImageDraw.Draw(im).multiline_text((40, 45), text, font=font, fill='black', spacing=20)
    im.save(root / (name + '.png'))
    if name == 'scan': im.save(root / 'scanned.pdf', 'PDF', resolution=100)
# A small deterministic text PDF, separate from the scanned-page path.
content = b'BT /F1 24 Tf 40 160 Td (Dispatch record: VIOLET-582) Tj 0 -36 Td (Parcel count: 29) Tj ET'
objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>', b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', b'<< /Length '+str(len(content)).encode()+b' >>\nstream\n'+content+b'\nendstream']
data = b'%PDF-1.4\n'; offsets = [0]
for i, obj in enumerate(objects, 1):
    offsets.append(len(data)); data += str(i).encode()+b' 0 obj\n'+obj+b'\nendobj\n'
xref = len(data); data += b'xref\n0 6\n0000000000 65535 f \n'
for offset in offsets[1:]: data += ('%010d 00000 n \n' % offset).encode()
data += b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+str(xref).encode()+b'\n%%EOF\n'
(root / 'dispatch.pdf').write_bytes(data)
(root / 'events.log').write_text(''.join('event %05d healthy\n' % n if n != 731 else 'event 00731 anomaly beacon CEDAR-418\n' for n in range(1, 15001)))
(root / 'small.log').write_text('boot complete\ncalibration marker JUNIPER-246\nshutdown clean\n')
(root / 'readings.csv').write_text('group,units\nnorth,17\nsouth,23\neast,31\nwest,11\n')
(root / 'malformed.csv').write_text('group,units\nnorth,"unterminated\n')
(root / 'unsafe.csv').write_text('label,value\nformula,=1+1\nnormal,42\n')
