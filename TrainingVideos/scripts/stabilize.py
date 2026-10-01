#!/usr/bin/env python3
"""stabilize.py in.mp4 out.mp4  : lock the frame to the static backdrop (translation via phase correlation on left/right strips vs a reference frame)."""
import cv2, numpy as np, subprocess, sys, os
os.environ["PATH"]=os.path.expanduser("~/.local/bin")+":"+os.environ["PATH"]
src, dst = sys.argv[1], sys.argv[2]
W,H=1920,1080
probe=subprocess.check_output(["ffprobe","-v","error","-select_streams","v:0","-show_entries","stream=r_frame_rate","-of","csv=p=0",src]).decode().strip()
fps=probe
rd=subprocess.Popen(["ffmpeg","-v","error","-i",src,"-f","rawvideo","-pix_fmt","bgr24","-"],stdout=subprocess.PIPE,bufsize=10**8)
tmpv=dst+".video.mp4"
wr=subprocess.Popen(["ffmpeg","-v","error","-y","-f","rawvideo","-pix_fmt","bgr24","-s",f"{W}x{H}","-r",fps,"-i","-","-c:v","libx264","-preset","fast","-crf","17","-pix_fmt","yuv420p",tmpv],stdin=subprocess.PIPE)
# strips of static backdrop: left and right thirds, below the top edge (avoid Josh who sits centre)
L=(slice(60,H-40),slice(40,520)); R=(slice(60,H-40),slice(W-520,W-40))
win=None; ref=None; n=0; shifts=[]
def gray(f): return cv2.cvtColor(f,cv2.COLOR_BGR2GRAY).astype(np.float32)
ZOOM=1.02
S=np.array([[ZOOM,0,-(ZOOM-1)*W/2],[0,ZOOM,-(ZOOM-1)*H/2]],dtype=np.float32)
while True:
    buf=rd.stdout.read(W*H*3)
    if len(buf)<W*H*3: break
    f=np.frombuffer(buf,np.uint8).reshape(H,W,3)
    g=gray(f)
    if ref is None:
        ref=g; win=cv2.createHanningWindow((L[1].stop-L[1].start,L[0].stop-L[0].start),cv2.CV_32F)
        dx=dy=0.0
    else:
        (dxl,dyl),rl=cv2.phaseCorrelate(ref[L],g[L],win)
        (dxr,dyr),rr=cv2.phaseCorrelate(ref[R],g[R],win)
        # weight by response; ignore wild values
        c=[(dxl,dyl,rl),(dxr,dyr,rr)]
        c=[x for x in c if abs(x[0])<60 and abs(x[1])<60]
        if c:
            wsum=sum(x[2] for x in c)+1e-6
            dx=sum(x[0]*x[2] for x in c)/wsum; dy=sum(x[1]*x[2] for x in c)/wsum
        else: dx=dy=0.0
    shifts.append((dx,dy))
    M=np.array([[1,0,-dx],[0,1,-dy]],dtype=np.float32)
    # compose: translate then zoom (zoom hides edges)
    M3=np.vstack([M,[0,0,1]]); S3=np.vstack([S,[0,0,1]]); T=(S3@M3)[:2]
    out=cv2.warpAffine(f,T,(W,H),flags=cv2.INTER_LINEAR,borderMode=cv2.BORDER_REPLICATE)
    wr.stdin.write(out.tobytes()); n+=1
    if n%900==0: print("frames",n,flush=True)
wr.stdin.close(); wr.wait(); rd.wait()
sh=np.array(shifts); print("frames",n,"max |dx|,|dy|",np.abs(sh).max(0).round(1),"rms",np.sqrt((sh**2).mean(0)).round(2))
subprocess.run(["ffmpeg","-v","error","-y","-i",tmpv,"-i",src,"-map","0:v","-map","1:a","-c:v","copy","-c:a","copy","-shortest",dst],check=True)
os.remove(tmpv); print("wrote",dst)
