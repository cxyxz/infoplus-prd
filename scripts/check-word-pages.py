import sys,json
from pathlib import Path
import pypdfium2 as pdfium
from PIL import Image,ImageDraw
root=Path(sys.argv[1])
for path in root.glob('*.qa.pdf'):
    doc=pdfium.PdfDocument(str(path)); business=path.name!='requirements.qa.pdf'
    prefix='business' if business else 'detailed'
    starts=[]
    for i,page in enumerate(doc):
        text=page.get_textpage().get_text_range()
        if business and '附录 A' in text and '完整业务流程图' in text: starts.append(i+1)
    print(json.dumps({'file':prefix,'pages':len(doc),'appendixA':starts},ensure_ascii=False))
    out=root/('qa-'+prefix);out.mkdir(exist_ok=True)
    for start in range(0,len(doc),12):
        sheet=Image.new('RGB',(1200,4*440),'#d0d0d0');draw=ImageDraw.Draw(sheet)
        for i in range(start,min(start+12,len(doc))):
            page=doc[i];img=page.render(scale=1).to_pil();img.thumbnail((390,410))
            x=((i-start)%3)*400;y=((i-start)//3)*440
            sheet.paste(img,(x,y+20));draw.text((x+8,y+3),str(i+1),fill='black')
        sheet.save(out/f'contact-{start//12}.jpg')
    if business:
        for i,page in enumerate(doc): page.render(scale=1.4).to_pil().save(out/f'page-{i+1}.png')
