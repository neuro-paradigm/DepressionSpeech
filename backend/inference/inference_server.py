"""Local FastAPI inference service for the SchNet, linguistic v11, and fusion models."""
import os, pickle, re, traceback
from pathlib import Path
from typing import List, Optional

import numpy as np
import soundfile as sf
import torch
import torch.nn as nn
import torch.nn.functional as F
import torchaudio.transforms as T
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from transformers import AutoModel, AutoTokenizer
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

ROOT = Path(__file__).resolve().parents[2]
MODELS = Path(os.getenv('FUSION_MODELS_DIR', Path(__file__).parent / 'models'))
BERT_MODEL_DIR = Path(os.getenv('BERT_MODEL_DIR', MODELS / 'clinical_bert_local'))
DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
vader = SentimentIntensityAnalyzer()

SADNESS = set('sad sorrow unhappy miserable grief cry tears hopeless despair broken empty numb dark bleak gloomy depressed depression down low lost alone lonely isolated worthless useless failure failed helpless trapped stuck meaningless pointless nothing nobody never always forever anymore'.split())
ANHEDONIA = set('enjoy enjoyed enjoyment pleasure fun interest interested hobby hobbies motivation motivated excited excitement care caring want wanted desire passion engaged engagement social friends family activities activity'.split())
SOMATIC = set('sleep sleeping slept insomnia tired tiredness exhausted exhaustion fatigue fatigued energy energetic appetite eating weight concentration concentrate focus focused distracted distraction slow sluggish heavy ache aching pain painful headache stomach body physical restless restlessness agitated agitation'.split())
COGNITIVE = set('think thinking thought thoughts mind mental forget forgetting forgetful memory remember remembering confused confusion unclear difficult difficulty hard struggle struggling overwhelmed overwhelming worry worrying worried ruminate ruminating rumination doubt doubting uncertain uncertainty blame blaming regret regretting should must never always everyone nobody nothing everything'.split())
POS_AFFECT = set('good great happy wonderful love enjoy fine okay well nice better best exciting positive grateful comfortable relaxed fortunate lucky appreciate glad hope hopeful motivated energetic calm peaceful content pleased satisfied proud confident strong healthy'.split())
DISFLUENCY = set('um uh uhh umm hmm mhm mm uh-huh hm'.split())
FP_WORDS = set('i me my myself mine'.split())
HEDGES = set('maybe perhaps possibly probably might could sometimes kind sort roughly approximately around about somewhat rather fairly like'.split())
CERTAINTY = set('definitely certainly absolutely clearly obviously always never every all none must will know sure certain exactly completely totally entirely really truly'.split())
FUNCTION_WORDS = set('a an the is are was were be been being have has had do does did will would could should may might shall can and but or nor for yet so at by from in into of on to with i me my we our you your he she it they them their this that these those not no if as than then when while where who which what how just also'.split())
SUBORD_CONJ = set('because although though even while since if unless until when whenever where wherever whether as after before once so than that despite however whereas'.split())
PHQ_DOMAINS = [set(x.split()) for x in ['little interest pleasure enjoy','feeling down depressed hopeless','sleep sleeping tired fatigue','appetite eating weight','failure worthless guilty','concentrate focus','slow restless','dead suicide self harm']]

def word_tokens(text): return re.findall(r"[a-zA-Z']+", text.lower())
def turn_ttr(text):
    words = word_tokens(text); return len(set(words)) / max(len(words), 1)
def turn_filler_ratio(text):
    words = word_tokens(text); return sum(w in DISFLUENCY for w in words) / max(len(words), 1)
def approx_syllables(word): return max(1, len(re.findall(r'[aeiouy]+', word.lower())))
def linreg_slope(values):
    return float(np.polyfit(np.arange(len(values)), values, 1)[0]) if len(values) > 1 else 0.0
def is_open_question(text):
    return '?' in text and bool(re.search(r'\b(what|why|how|tell|describe|when|where)\b', text.lower()))

def extract_ling_features(rec):
    """The v11 107-feature layout. Missing timing values intentionally use training defaults (-1/0)."""
    turns, patient_text = rec['turns'], rec['patient_text']
    words = word_tokens(patient_text); sentences = [s.strip() for s in re.split(r'[.!?]+', patient_text) if s.strip()]
    n_words, n_sents = max(len(words), 1), max(len(sentences), 1); sent_lens = [len(word_tokens(s)) for s in sentences] or [0]
    pat = [t for t in turns if t['speaker'] == 'participant']; inter = [t for t in turns if t['speaker'] == 'interviewer']; n_pat, n_int = max(len(pat), 1), max(len(inter), 1)
    counts = [sum(w in group for w in words) for group in (SADNESS, ANHEDONIA, SOMATIC, COGNITIVE, POS_AFFECT, DISFLUENCY, FP_WORDS)]
    sad, anh, som, cog, pos, dis, fp = counts; rates = [v / n_words for v in counts]
    sad_r, anh_r, som_r, cog_r, pos_r, dis_r, fp_r = rates; neg = sad + som + cog; neg_r = neg / n_words
    wc = {}; [wc.__setitem__(w, wc.get(w, 0) + 1) for w in words]
    texts = [t['text'] for t in pat]; ttrs = [turn_ttr(t) for t in texts] or [0.0]; fillers = [turn_filler_ratio(t) for t in texts] or [0.0]
    turn_vars = [float(np.var([len(word_tokens(s)) for s in re.split(r'[.!?]+', t) if s.strip()] or [len(word_tokens(t))])) for t in texts] or [0.0]
    seen, novelty = set(), []
    for text in texts:
        tw = set(word_tokens(text)); novelty.append(len(tw-seen)/max(len(tw),1)); seen |= tw
    novelty = novelty or [1.0]; monotony = sum(bool(set(word_tokens(texts[i-1])) & set(word_tokens(texts[i]))) for i in range(1,len(texts))) / max(len(texts)-1,1)
    scores = [vader.polarity_scores(t)['compound'] for t in texts] or [0.0]; third_turn = max(len(scores)//3,1)
    pat_lens = [len(word_tokens(t)) for t in texts] or [0]; int_lens = [len(word_tokens(t['text'])) for t in inter] or [1]
    elab = [len(word_tokens(turns[i]['text'])) / max(len(word_tokens(turns[i-1]['text'])),1) for i in range(1,len(turns)) if turns[i]['speaker']=='participant' and turns[i-1]['speaker']=='interviewer'] or [1.0]
    open_elab = [x for i,x in enumerate(elab) if i < len(inter) and is_open_question(inter[i]['text'])] or [1.0]
    closed_elab = [x for i,x in enumerate(elab) if i >= len(inter) or not is_open_question(inter[i]['text'])] or [1.0]
    q = max(n_pat//4,1)
    def sadness_rate(items):
        ws = word_tokens(' '.join(t['text'] for t in items)); return sum(w in SADNESS for w in ws)/max(len(ws),1)
    quarters = [sadness_rate(pat[i*q:(i+1)*q]) for i in range(4)]
    neg_third = max(len(words)//3,1); neg_early=sum(w in SADNESS or w in SOMATIC for w in words[:neg_third])/neg_third; neg_late=sum(w in SADNESS or w in SOMATIC for w in words[-neg_third:])/neg_third
    moving = [turn_ttr(' '.join(texts[i:i+5])) for i in range(max(len(texts)-4,0))] or [float(np.mean(ttrs))]
    values = [
        len(set(words))/n_words, np.mean([len(w) for w in words]) if words else 0, n_words/n_sents, np.std(sent_lens), sad_r,anh_r,som_r,cog_r,pos_r,dis_r,fp_r,neg_r/max(pos_r,.001),np.log1p(n_words),np.log1p(neg),sum(x<=4 for x in sent_lens)/n_sents,n_sents/max(np.log1p(n_words),1),sum(any(w in SADNESS or w in SOMATIC or w in COGNITIVE for w in word_tokens(s)) for s in sentences)/n_sents,sum(x>2 for x in wc.values())/max(len(wc),1),patient_text.count('?')/n_sents,
        np.clip(neg/5,0,1),np.clip(neg/10,0,1),np.clip(neg/15,0,1),sad_r*fp_r,sum(x>0 for x in [sad,anh,som,cog])/4,neg_r*fp_r,
        np.mean(scores),np.std(scores),np.min(scores),np.max(scores),np.mean(scores[:third_turn]),np.mean(scores[-third_turn:]),np.mean(scores[-third_turn:])-np.mean(scores[:third_turn]),sum(x<-.3 for x in scores)/len(scores),sum(x>.3 for x in scores)/len(scores),np.mean(scores)*fp_r,np.max(scores)-np.min(scores),
        -1,0,-1,0,0,-1,0,0,0,0,
        np.mean(pat_lens),np.std(pat_lens),sum(x<=5 for x in pat_lens)/n_pat,sum(x>50 for x in pat_lens)/n_pat,sum(pat_lens)/max(sum(pat_lens)+sum(int_lens),1),float(n_pat),float(n_int),float(n_pat)/max(len(turns),1),sum(any(w in domain for w in words) for domain in PHQ_DOMAINS)/8,sum(is_open_question(t['text']) for t in inter)/n_int,
        np.mean(elab),np.std(elab),np.percentile(elab,25),np.percentile(elab,75),np.percentile(elab,75)-np.percentile(elab,25),np.min(elab),np.mean(open_elab),np.mean(closed_elab),np.mean(open_elab)/max(np.mean(closed_elab),.1),linreg_slope(elab),*quarters,max(quarters)-min(quarters),neg_early,neg_late,neg_late-neg_early,
        np.log1p(sad),np.log1p(som),np.log1p(cog),np.log1p(anh),np.log1p(dis),np.log1p(fp),np.log1p(n_words),np.mean(ttrs),np.std(ttrs),np.min(ttrs),np.mean(turn_vars),np.mean(fillers),np.std(fillers),np.mean(novelty),monotony,np.mean(moving),np.min(moving),moving[-1]-moving[0],(1-np.mean(ttrs))*.4+np.mean(fillers)*.3+(1-np.mean(novelty))*.3,(np.max(scores)-np.min(scores))*(1-np.mean(ttrs)),
        sum(w in SUBORD_CONJ for w in words)/n_sents,np.mean([x for x in sent_lens if x>10] or [0]),sum(w not in FUNCTION_WORDS for w in words)/n_words,sum(w in HEDGES for w in words)/n_words,sum(w in CERTAINTY for w in words)/n_words,linreg_slope(pat_lens),0,
    ]
    result = np.asarray(values, dtype=np.float32)
    if result.shape != (101,): raise RuntimeError(f'v11 feature construction produced {result.shape[0]} values, expected 101.')
    return result

class CBAM(nn.Module):
    def __init__(self, channels, reduction=16):
        super().__init__(); self.channel_fc=nn.Sequential(nn.Conv2d(channels,channels//reduction,1,bias=False),nn.ReLU(),nn.Conv2d(channels//reduction,channels,1,bias=False)); self.spatial_conv=nn.Conv2d(2,1,7,padding=3,bias=False); self.post_conv=nn.Sequential(nn.Conv2d(channels,channels,3,padding=1,bias=False),nn.BatchNorm2d(channels))
    def forward(self,x):
        x=x*torch.sigmoid(self.channel_fc(x.mean((2,3),keepdim=True))+self.channel_fc(x.amax((2,3),keepdim=True))); x=x*torch.sigmoid(self.spatial_conv(torch.cat([x.mean(1,keepdim=True),x.amax(1,keepdim=True)],1))); return F.relu(self.post_conv(x))
class SchNet(nn.Module):
    def __init__(self):
        super().__init__(); self.mel=T.MelSpectrogram(sample_rate=16000,n_fft=1024,hop_length=512,n_mels=64); self.db=T.AmplitudeToDB(top_db=80)
        def block(a,b,stride=1): return nn.Sequential(nn.Conv2d(a,b,3,stride=stride,padding=1,bias=False),nn.BatchNorm2d(b))
        self.conv1a,self.conv1b=block(1,32),block(32,32); self.conv2a,self.conv2b=block(32,64,2),block(64,64); self.conv3a,self.conv3b=block(64,128,2),block(128,128); self.conv4a,self.conv4b=block(128,256,2),block(256,256); self.skip1=nn.Sequential(nn.Conv2d(32,256,1,stride=8,bias=False),nn.BatchNorm2d(256)); self.skip2=nn.Sequential(nn.Conv2d(64,256,1,stride=4,bias=False),nn.BatchNorm2d(256)); self.skip3=nn.Sequential(nn.Conv2d(128,256,1,stride=2,bias=False),nn.BatchNorm2d(256)); self.conv5,self.conv6,self.conv7,self.conv8=block(1024,256),block(256,256),block(256,256),block(256,256); self.attention=CBAM(256); self.classifier=nn.Sequential(nn.AdaptiveAvgPool2d(1),nn.BatchNorm1d(256),nn.Linear(256,128),nn.ReLU(),nn.Dropout(.4),nn.Linear(128,1))
    def forward(self,wav):
        x=self.db(self.mel(wav)).unsqueeze(1); x1=F.relu(self.conv1b(F.relu(self.conv1a(x)))); x2=F.relu(self.conv2b(F.relu(self.conv2a(x1)))); x3=F.relu(self.conv3b(F.relu(self.conv3a(x2)))); x4=F.relu(self.conv4b(F.relu(self.conv4a(x3)))); out=self.attention(F.relu(self.conv8(F.relu(self.conv7(F.relu(self.conv6(F.relu(self.conv5(torch.cat([x4,self.skip1(x1),self.skip2(x2),self.skip3(x3)],1)))))))))); out=self.classifier[0](out).flatten(1); return self.classifier[5](self.classifier[4](self.classifier[3](self.classifier[2](self.classifier[1](out))))).squeeze(1)
class FusionMLP(nn.Module):
    def __init__(self): super().__init__(); self.net=nn.Sequential(nn.Linear(4,16),nn.BatchNorm1d(16),nn.ReLU(),nn.Dropout(.3),nn.Linear(16,8),nn.ReLU()); self.cls_head=nn.Linear(8,1); self.reg_head=nn.Linear(8,1)
    def forward(self,x): h=self.net(x); return self.cls_head(h).squeeze(1),self.reg_head(h).squeeze(1)

class Pair(BaseModel): question_id: str; prompt: str; response: str
class Request(BaseModel): prompt_responses: List[Pair] = Field(min_length=1); audio_paths: List[str] = []
app=FastAPI(title='Fusion Inference Service'); state={}
def artifact(name):
    local=MODELS/name; return local if local.exists() else ROOT/name
@app.on_event('startup')
def load_models():
    fusion=pickle.load(open(artifact('fusion_model_v1.pkl'),'rb')); ling=pickle.load(open(artifact('depression_model_v11.pkl'),'rb'))
    sch=SchNet().to(DEVICE); sch.load_state_dict(torch.load(artifact('fold_1_schnet.pth'),map_location=DEVICE),strict=False); sch.eval()
    fm=FusionMLP().to(DEVICE); fm.load_state_dict(fusion['fusion_mlp_state']); fm.eval()
    bert_dir = BERT_MODEL_DIR if BERT_MODEL_DIR.exists() else MODELS / 'bioclinical_bert'
    tokenizer=AutoTokenizer.from_pretrained(bert_dir,local_files_only=True); bert=AutoModel.from_pretrained(bert_dir,local_files_only=True).to(DEVICE); bert.eval()
    state.update(fusion=fusion,ling=ling,schnet=sch,fusion_model=fm,tokenizer=tokenizer,bert=bert)
@app.get('/health')
def health(): return {'status':'ok','device':str(DEVICE),'bert_local':str(BERT_MODEL_DIR)}
@torch.no_grad()
def embed(text):
    tok=state['tokenizer']; ids=tok(text,add_special_tokens=False)['input_ids'];
    if not ids: return np.zeros(768,np.float32)
    chunks=[]
    for start in range(0,len(ids),256):
        chunk=[tok.cls_token_id]+ids[start:start+510]+[tok.sep_token_id]; pad=[tok.pad_token_id or 0]*(512-len(chunk)); out=state['bert'](input_ids=torch.tensor([chunk+pad],device=DEVICE),attention_mask=torch.tensor([[1]*len(chunk)+[0]*len(pad)],device=DEVICE)); chunks.append(out.last_hidden_state[0,0].cpu().numpy())
        if start+510>=len(ids): break
    return np.mean(chunks,0).astype(np.float32)
def schnet_prob(paths):
    logits=[]
    for p in paths:
        # Use soundfile instead of torchaudio.load to avoid torchcodec/FFmpeg dependency
        data, sr = sf.read(p, dtype='float32')
        wav = torch.from_numpy(data)
        if wav.dim() == 1:
            wav = wav.unsqueeze(0)          # mono: (samples,) -> (1, samples)
        else:
            wav = wav.T                      # multi-ch: (samples, ch) -> (ch, samples)
            wav = wav.mean(0, keepdim=True)  # mix down to mono
        if sr != 16000:
            wav = T.Resample(sr, 16000)(wav)
        length = 480000
        starts = [0] if wav.shape[1] <= length else np.linspace(0, wav.shape[1] - length, 5, dtype=int)
        for start in starts:
            piece = wav[:, start:start+length]
            piece = F.pad(piece, (0, max(0, length - piece.shape[1])))
            logits.append(state['schnet'](piece.to(DEVICE)).item())
    return None if not logits else float(torch.sigmoid(torch.tensor(np.mean(logits))).item())
@app.post('/predict')
def predict(req: Request):
    try:
        turns = []
        for pair in req.prompt_responses:
            turns.extend([{'speaker': 'interviewer', 'text': pair.prompt},
                          {'speaker': 'participant', 'text': pair.response}])
        patient = ' '.join(p.response for p in req.prompt_responses).strip()
        if not patient:
            raise HTTPException(422, 'At least one participant response is required.')

        # --- Linguistic model ---
        ling = state['ling']
        rich = extract_ling_features({'turns': turns, 'patient_text': patient})
        masked = rich[ling['feature_mask']]
        x = np.concatenate([
            ling['scaler_rich'].transform(masked.reshape(1, -1)),
            ling['scaler_bert'].transform(ling['svd'].transform(embed(patient).reshape(1, -1)))
        ], 1)
        raw = ling['logreg'].predict_proba(x)[0, list(ling['logreg'].classes_).index(1)]
        ling_p = float(ling['platt_calibrator'].predict_proba([[raw]])[0, 1])

        # --- Audio model (SchNet) ---
        sch_p = schnet_prob(req.audio_paths)
        if sch_p is None:
            raise HTTPException(422, 'No readable audio files were supplied; fusion requires both modalities.')

        # --- Fusion ---
        meta = torch.tensor([[sch_p, ling_p, abs(sch_p - ling_p), sch_p * ling_p]],
                            dtype=torch.float32, device=DEVICE)
        with torch.no_grad():
            cls, _ = state['fusion_model'](meta)
            fp = float(torch.sigmoid(cls).item())
        threshold = float(state['fusion']['thresh_youden'])
        sev = float(state['fusion']['iso_severity'].predict([fp])[0])

        return {
            'schnet_prob': sch_p, 'ling_prob': ling_p, 'fusion_prob': fp,
            'pred_binary': int(fp >= threshold), 'phq8_est': sev,
            'threshold_used': threshold, 'threshold_type': 'youden',
            'classification': 'DEPRESSED' if fp >= threshold else 'NON-DEPRESSED',
            'biomarkers_107': rich.tolist(),
            'data_format_limitations': [
                'Prompt text is represented as synthetic interviewer turns.',
                'Recording timestamps and interviewer interaction timing are unavailable and use neutral defaults.',
            ],
            'device': str(DEVICE),
        }
    except HTTPException:
        raise
    except Exception as exc:
        tb = traceback.format_exc()
        print(f'[predict] ERROR: {exc}\n{tb}')
        return JSONResponse(status_code=500, content={'detail': str(exc), 'traceback': tb})
