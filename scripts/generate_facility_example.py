"""Generate a synthetic example (no branch data) for the public import demo."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'assets' / 'facility-3d'
DEST.mkdir(parents=True, exist_ok=True)
FONT = Path('C:/Windows/Fonts/malgun.ttf')
segments = [(60,60,1140,60),(60,740,1140,740),(60,60,60,740),(1140,60,1140,740),
            (60,350,1140,350),(60,450,1140,450)]
for x in (420,780):
    segments.extend([(x,60,x,350),(x,450,x,740)])
labels = [('상담실',240,205),('사무실',600,205),('간호실',960,205),('복도',600,400),
          ('201호 생활실',240,595),('식당',600,595),('프로그램실',960,595)]
img=Image.new('RGB',(1200,800),'white')
draw=ImageDraw.Draw(img)
for segment in segments:draw.line(segment,fill='#242424',width=8)
for y in (350,450):
    for x in (240,600,960):draw.rectangle((x-14,y-5,x+14,y+5),fill='white')
font=ImageFont.truetype(str(FONT),34)
for text,x,y in labels:draw.text((x,y),text,font=font,fill='#222222',anchor='mm')
img.save(DEST/'example-floorplan.png')
pdfmetrics.registerFont(TTFont('ExampleKorean',str(FONT)))
pdf=canvas.Canvas(str(DEST/'example-floorplan.pdf'),pagesize=(1200,800))
pdf.setTitle('Synthetic facility floorplan example')
for page in range(2):
    pdf.setStrokeColorRGB(.14,.14,.14);pdf.setLineWidth(8)
    for x1,y1,x2,y2 in segments:pdf.line(x1,800-y1,x2,800-y2)
    pdf.setFillColorRGB(1,1,1)
    for y in (350,450):
        for x in (240,600,960):pdf.rect(x-14,800-y-5,28,10,stroke=0,fill=1)
    pdf.setFillColorRGB(.13,.13,.13);pdf.setFont('ExampleKorean',34)
    for text,x,y in labels:
        if page==1 and text=='201호 생활실':text='301호 생활실'
        pdf.drawCentredString(x,800-y-12,text)
    pdf.showPage()
pdf.save()
print('Synthetic image and two-page PDF generated')
