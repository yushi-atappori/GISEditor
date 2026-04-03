/* app.core.js */
(function(){
  "use strict";
  if(!window.L) { alert("Leaflet が読み込めていません。./libs/leaflet/ を確認してください。"); return; }

  const $ = s => document.querySelector(s);
  const statusEl = $('#status');
  const legendItems = $('#legend-items');
  const legendBody = $('#legend-body');

  /* ===== util ===== */
  function setStatus(s){ statusEl.textContent = s; }
  function download(name, obj){
    const blob = (obj instanceof Blob) ? obj : new Blob([obj], {type:'application/octet-stream'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download=name;
    document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 500);
  }
  function escapeHtml(x){ return String(x).replace(/[&<>\"']/g, s=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[s])); }
  function basename(name){ return (name||'').split(/[\\/]/).pop(); }
  function stem(name){ const b=basename(name); return b.replace(/\.(geojson|json|zip|shp|dbf|shx|prj)$/i,''); }
  function timeStamp(){ return new Date().toISOString().replace(/[:.]/g,'').slice(0,15); }
  function normStr(s,{trim=true,nfkc=true,lower=false}={}){ if(s==null) return ''; let t=String(s); if(nfkc&&t.normalize) t=t.normalize('NFKC'); if(trim) t=t.trim(); if(lower) t=t.toLowerCase(); return t; }
  function parseList(text){ if(!text) return []; return text.split(/[\n,]+/).map(v=>v.trim()).filter(v=>v.length>0); }

  /* ===== map ===== */
  const map = L.map('map', { center:[36.7,137.2], zoom:10 });

  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{ attribution:'© OpenStreetMap' }).addTo(map);
  const gsiPale  = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',{ attribution:'地理院タイル（淡色）', maxZoom:18 });
  const gsiBlank = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/blank/{z}/{x}/{y}.png',{ attribution:'地理院タイル（白地図）', maxZoom:18 });

  L.control.layers({ "OSM":osm, "GSI 淡色":gsiPale, "GSI 白地図":gsiBlank }, {}, {position:'topright', collapsed:false}).addTo(map);
  setTimeout(()=> map.invalidateSize(), 0);

  const canvasRenderer = L.canvas({ padding:0.2 });
  const baseRoot  = L.layerGroup().addTo(map);
  const layerRoot = L.layerGroup().addTo(map);

  // パネル/凡例内のイベントは地図へ波及させない
  L.DomEvent.disableScrollPropagation(document.getElementById('panel'));
  L.DomEvent.disableClickPropagation (document.getElementById('panel'));
  L.DomEvent.disableScrollPropagation(document.getElementById('legend'));
  L.DomEvent.disableClickPropagation (document.getElementById('legend'));

  /* ===== data ===== */
  let fcAll = { type:'FeatureCollection', features:[] };
  let baseLayer = null;

  // 色分類
  let classifyMap = new Map();
  let currentKey = '';
  const defaultPalette = ['#1f77b4','#ff7f0e','#2ca02c','#d62728','#9467bd','#8c564b','#e377c2','#7f7f7f','#bcbd22','#17becf'];

  // レイヤ
  let layerKey = '';
  let layerMap = new Map();
  let layerOrder = [];

  // Undo
  let undoBuffer = null;

  // 読み込み順安定化
  let ordSeq = 0;

  // ★ V23: ファイル取り込み順（_src_order）
  let srcOrderSeq = 0;

  function styleOf(f){
    const props=f.properties||{};
    const val = (currentKey? props[currentKey]: null);
    const col = (val!=null && classifyMap.has(String(val))) ? classifyMap.get(String(val))
              : (props.FILL||props.fill||'#1976d2');

    const sw = Number($('#stroke-width').value||2);
    const so = Math.max(0,Math.min(1, Number($('#stroke-op').value||1)));
    const fo = Math.max(0,Math.min(1, Number($('#fill-op').value||0.4)));
    const weight = props.WIDTH ?? sw;
    const op = props.STROKE_OP ?? so;
    const fop = props.FILL_OP ?? fo;
    return { color: col, weight, opacity: op, fillColor: col, fillOpacity: fop };
  }

  function refreshBase(){
    if(baseLayer){ baseRoot.removeLayer(baseLayer); baseLayer=null; }
    baseLayer = L.geoJSON(fcAll, {
      renderer: canvasRenderer,
      style: styleOf,
      onEachFeature:(f,lyr)=>{ lyr.bindPopup(`<pre class="mono" style="margin:0">${JSON.stringify(f.properties||{}, null, 2)}</pre>`); }
    }).addTo(baseRoot);
    try{ map.fitBounds(baseLayer.getBounds(), { maxZoom:14 }); }catch{}
    $('#feat-count').textContent = `${fcAll.features.length} features`;
  }

  /* ===== layer split/order ===== */
  function clearLayers(clearList=true){
    layerMap.forEach(o=>{
      if(o.layer) layerRoot.removeLayer(o.layer);
      const p = o.pane && map.getPane(o.pane);
      if(p) p.remove();
    });
    layerMap.clear();
    if(clearList){ layerOrder=[]; $('#order-list').innerHTML=''; }
  }

  function computeArea(f){ try{ return turf.area(f)||0; }catch{ return 0; } }

  function groupByLayerKey(){
    const group = new Map();
    for(const f of fcAll.features){
      const props = f.properties || {};
      const v = props[layerKey];
      const k = String(v);
      const arr = group.get(k) || [];
      arr.push(f);
      group.set(k, arr);
    }
    const g2 = new Map();
    for(const [k,arr] of group.entries()){
      const area = arr.reduce((s,f)=> s+computeArea(f),0);
      let orderHint = null;
      for(const ft of arr){
        const v = Number((ft.properties || {})._layer_order);
        if(Number.isFinite(v)) orderHint = (orderHint==null)? v : Math.min(orderHint, v);
      }
      g2.set(k, {arr, area, orderHint});
    }
    return g2;
  }

  function buildLayers(){
    clearLayers();
    layerKey = $('#layer-key').value.trim();
    if(!layerKey){ setStatus('レイヤキーを入力してください'); return; }

    const group = groupByLayerKey();
    const mode = $('#order-init').value;
    const entries = [...group.entries()].map(([k,obj])=>({ k, arr:obj.arr, area:obj.area, orderHint:obj.orderHint }));

    const hasOrderHintForAll = entries.length>0 && entries.every(e=> e.orderHint != null);
    if(hasOrderHintForAll){
      entries.sort((a,b)=> (a.orderHint===b.orderHint) ? a.k.localeCompare(b.k,'ja') : (a.orderHint-b.orderHint));
    }else{
      if(mode==='asc') entries.sort((a,b)=> a.k.localeCompare(b.k,'ja'));
      else if(mode==='desc') entries.sort((a,b)=> b.k.localeCompare(a.k,'ja'));
      else if(mode==='area_desc') entries.sort((a,b)=> b.area-a.area);
      else if(mode==='area_asc') entries.sort((a,b)=> a.area-b.area);
    }

    const baseZ = 51000;
    layerOrder = entries.map(e=> e.k);

    entries.forEach((e,idx)=>{
      const safeKey = e.k.replace(/[^\w.-]/g,'_');
      const paneName = `pane_${idx}_${safeKey}`;
      const pane = map.createPane(paneName);
      pane.style.zIndex = String(baseZ + (entries.length - idx)); // 先頭が最前面

      const lyr = L.geoJSON(
        {type:'FeatureCollection',features:e.arr},
        {
          pane:paneName,
          renderer:canvasRenderer,
          style:styleOf,
          onEachFeature:(f,layer)=>{
            layer.bindPopup(
              `<div class="mono">${escapeHtml(layerKey)}=${escapeHtml(e.k)}</div>` +
              `<pre class="mono" style="margin:4px 0 0">${JSON.stringify(f.properties||{},null,2)}</pre>`
            );
          }
        }
      ).addTo(layerRoot);

      layerMap.set(e.k, { pane:paneName, layer:lyr, feats:e.arr, area:e.area, orderHint:e.orderHint });
    });

    window.AppUI.buildOrderList();
    setStatus(hasOrderHintForAll ? `レイヤ構築：${layerMap.size} / 既存 _layer_order を優先` : `レイヤ構築：${layerMap.size} / 初期順=${mode}`);
  }

  function applyOrder(){
    const baseZ=51000; const n=layerOrder.length;
    layerOrder.forEach((k,idx)=>{
      const o=layerMap.get(k); if(!o) return;
      const pane=map.getPane(o.pane);
      if(pane) pane.style.zIndex = String(baseZ + (n - idx));
    });
    setStatus('レイヤ順を反映しました');
  }

  function exportOrderCsv(){
    const lines=[['order','layer_key','total_area_sqm','feature_count']];
    layerOrder.forEach((k,i)=>{
      const o=layerMap.get(k)||{area:0,feats:[]};
      lines.push([i+1,k,Math.round(o.area),(o.feats||[]).length]);
    });
    const csv=lines.map(r=>r.map(x=>`"${String(x).replace(/"/g,'""')}"`).join(',')).join('\r\n');
    download(`layer_order_${timeStamp()}.csv`, new Blob([csv],{type:'text/csv'}));
  }

  /* ===== delete filter ===== */
  function buildDeletePredicate(){
    const key=($('#del-key').value||$('#class-key').value||'').trim();
    if(!key){ setStatus('削除キー（列名）を入力してください'); return null; }
    const mode=$('#del-mode').value;
    const vals=parseList($('#del-values').value);
    const opt={ trim:$('#del-trim').checked, nfkc:$('#del-nfkc').checked, lower:$('#del-ignorecase').checked };
    if(vals.length===0){ setStatus('削除する値を入力してください'); return null; }
    const nVals=vals.map(v=>normStr(v,opt));
    if(mode==='exact'){ const set=new Set(nVals); return props=> set.has(normStr((props||{})[key],opt)); }
    return props=>{ const t=normStr((props||{})[key],opt); return nVals.some(v=>t.includes(v)); };
  }
  function previewDelete(){
    const pred=buildDeletePredicate(); if(!pred) return;
    let hit=0; for(const f of fcAll.features){ try{ if(pred(f.properties)) hit++; }catch{} }
    setStatus(`削除プレビュー：${hit} 件（全 ${fcAll.features.length}）`); return hit;
  }
  function execDelete(){
    const pred=buildDeletePredicate(); if(!pred) return;
    undoBuffer={ type:'FeatureCollection', features: fcAll.features.map(f=> JSON.parse(JSON.stringify(f))) };
    const before=fcAll.features.length;
    fcAll.features=fcAll.features.filter(f=>{ try{ return !pred(f.properties);}catch{ return true; } });
    const removed=before-fcAll.features.length;
    refreshBase();
    setStatus(`削除：${removed} 件（残 ${fcAll.features.length}）`);
  }
  function undoOnce(){
    if(!undoBuffer){ setStatus('直前の状態がありません'); return; }
    fcAll=undoBuffer; undoBuffer=null; refreshBase(); setStatus('元に戻しました');
  }

  /* ===== restore/classify/legend ===== */
  function renderClassTableFromMap(cntMap=null){
    const wrap=$('#class-table-wrap');
    const rows=[];
    const entries=[...classifyMap.entries()];
    entries.forEach(([v,c])=>{
      rows.push(`<tr>
        <td>${escapeHtml(v)}</td>
        <td><input type="color" value="${c}" data-k="${encodeURIComponent(v)}" class="colpick"/></td>
        <td style="text-align:right">${cntMap? (cntMap.get(String(v))||0) : ''}</td>
      </tr>`);
    });
    wrap.innerHTML=`<table class="table"><thead><tr><th>値 (${currentKey||'-'})</th><th>色</th><th>件数</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
    wrap.querySelectorAll('.colpick').forEach(inp=>{
      inp.addEventListener('input',e=>{
        const key=decodeURIComponent(e.target.dataset.k);
        classifyMap.set(String(key), e.target.value);
      });
    });
  }

  function updateLegend(){
    legendItems.innerHTML='';
    [...classifyMap.entries()].forEach(([k,c])=>{
      const div=document.createElement('div');
      div.style.display='flex'; div.style.alignItems='center'; div.style.gap='8px'; div.style.margin='2px 0';
      div.innerHTML=`<span style="display:inline-block;width:14px;height:14px;border:1px solid #cbd5e1;background:${c};"></span> <span>${escapeHtml(k)}</span>`;
      legendItems.appendChild(div);
    });
    window.AppUI.resizeLegend();
  }

  function tryRestoreStyle(){
    classifyMap.clear();
    const key=$('#class-key').value.trim();
    currentKey = key || currentKey;

    const sw=$('#stroke-width'), so=$('#stroke-op'), fo=$('#fill-op');
    for(const f of fcAll.features){
      const p=f.properties||{};
      const val= key ? p[key] : undefined;
      const stroke=p.STROKE||p.stroke;
      const fill=p.FILL||p.fill;
      const sopacity=p.STROKE_OP ?? p['stroke-opacity'] ?? p.opacity;
      const fopacity=p.FILL_OP ?? p['fill-opacity'];

      if(val!=null){
        const c=fill||stroke;
        if(c && !classifyMap.has(String(val))) classifyMap.set(String(val),c);
      }
      if(sopacity!=null) so.value=String(Math.max(0,Math.min(1,Number(sopacity))));
      if(fopacity!=null) fo.value=String(Math.max(0,Math.min(1,Number(fopacity))));
      if(p.WIDTH!=null)  sw.value=String(Number(p.WIDTH));
    }

    if(classifyMap.size===0 && currentKey){
      const vals=[...new Set(fcAll.features.map(f=>(f.properties||{})[currentKey]))];
      vals.forEach((v,i)=> classifyMap.set(String(v), defaultPalette[i%defaultPalette.length]));
    }
    renderClassTableFromMap();
    updateLegend();
    refreshBase();
    setStatus('既存スタイルを復元（可能な範囲）');
  }

  function buildKeyGuess(){
    const f=fcAll.features.find(x=>x&&x.properties&&Object.keys(x.properties).length);
    if(!f) return;
    const keys=Object.keys(f.properties);
    const prefer=['YoutoName','用途','zone','category','class','name','_src','Cityname','A29_001'];
    const hit=prefer.find(k=>keys.includes(k));
    if(hit){
      $('#class-key').value=hit;
      if(!$('#layer-key').value) $('#layer-key').value=hit;
    }
  }

  function buildClassifyTable(){
    currentKey=$('#class-key').value.trim();
    if(!currentKey){ setStatus('分類キーを入力してください'); return; }
    const cntMap=new Map();
    for(const f of fcAll.features){
      const v=(f.properties||{})[currentKey];
      const k=String(v);
      cntMap.set(k,(cntMap.get(k)||0)+1);
    }
    const uniq=[...cntMap.keys()].sort();
    classifyMap=new Map();
    uniq.forEach((v,i)=> classifyMap.set(String(v), defaultPalette[i%defaultPalette.length]));
    renderClassTableFromMap(cntMap);
    setStatus(`分類テーブル生成：${uniq.length}カテゴリ`);
  }

  function applyDefaults(){
    $('#stroke-width').value='2';
    $('#stroke-op').value='1';
    $('#fill-op').value='0.4';
    buildKeyGuess();
    const key=$('#class-key').value.trim();
    if(key && fcAll.features.length){
      buildClassifyTable();
      updateLegend();
    } else {
      classifyMap.clear();
    }
    refreshBase();
    setStatus('デフォルトを適用しました');
  }

  /* ===== V23: normalize keys ===== */
  function normalizeConfigFromUI(){
    return {
      layerGroupFrom: ($('#norm-layer-group-from').value||'_src').trim() || '_src',
      lockDefault: $('#norm-lock-default').value || 'read',
      styleKeyMode: $('#norm-style-key-mode').value || 'classValue',
      srcOrderMode: $('#norm-src-order-mode').value || 'keep',
    };
  }

  function ensureNormalizedKeys({layerGroupFrom, lockDefault, styleKeyMode, srcOrderMode}){
    const classKey = ($('#class-key').value||'').trim();
    let missing = { _src_order:0, _layer_group:0, _style_key:0, _lock:0 };

    // _src_order 再計算が必要なら、_src の登場順を作る（ファイル由来の順序を近似）
    // ※ 読み込み時の _src_order が最も正確。recalc は「現時点の _src の並び」から再採番。
    let srcToOrder = null;
    if(srcOrderMode === 'recalc'){
      srcToOrder = new Map();
      let seq=0;
      for(const f of fcAll.features){
        const src = String((f.properties||{})._src ?? '');
        if(!srcToOrder.has(src)) srcToOrder.set(src, ++seq);
      }
    }

    for(const f of fcAll.features){
      const p = f.properties || (f.properties={});

      // _src_order
      if(srcOrderMode === 'recalc'){
        p._src_order = srcToOrder.get(String(p._src ?? '')) ?? 0;
      }else{
        if(p._src_order == null){ missing._src_order++; p._src_order = (p._src_order ?? 0); }
      }

      // _layer_group
      if(p._layer_group == null){
        missing._layer_group++;
        p._layer_group = String(p[layerGroupFrom] ?? p._src ?? '');
      }

      // _style_key
      if(p._style_key == null){
        missing._style_key++;
        if(styleKeyMode === 'classKeyName'){
          p._style_key = classKey || '';
        }else{
          // classValue
          p._style_key = classKey ? String(p[classKey] ?? '') : '';
        }
      }

      // _lock
      if(p._lock == null){
        missing._lock++;
        p._lock = lockDefault;
      }
    }
    return missing;
  }

  function previewNormalize(){
    const cfg = normalizeConfigFromUI();
    // クローンに対して集計のみ
    let stats = { total: fcAll.features.length, missing:{_src_order:0,_layer_group:0,_style_key:0,_lock:0} };
    for(const f of fcAll.features){
      const p=f.properties||{};
      if(p._src_order==null) stats.missing._src_order++;
      if(p._layer_group==null) stats.missing._layer_group++;
      if(p._style_key==null) stats.missing._style_key++;
      if(p._lock==null) stats.missing._lock++;
    }
    const html = `
<div><b>総フィーチャ</b>：${stats.total}</div>
<div style="margin-top:6px;"><b>未付与件数（現状）</b></div>
<table class="table">
<thead><tr><th>キー</th><th>未付与</th></tr></thead>
<tbody>
<tr><td>_src_order</td><td>${stats.missing._src_order}</td></tr>
<tr><td>_layer_group</td><td>${stats.missing._layer_group}</td></tr>
<tr><td>_style_key</td><td>${stats.missing._style_key}</td></tr>
<tr><td>_lock</td><td>${stats.missing._lock}</td></tr>
</tbody></table>
<div class="muted">実行時：_layer_group は「${escapeHtml(cfg.layerGroupFrom)}」から初期設定、_lock=${escapeHtml(cfg.lockDefault)}。</div>`;
    const box = $('#norm-preview');
    box.style.display='block';
    box.innerHTML=html;
    setStatus('正規化キーのプレビューを作成しました');
  }

  function doNormalize(){
    const cfg = normalizeConfigFromUI();
    const missing = ensureNormalizedKeys(cfg);
    refreshBase();
    setStatus(`正規化キーを付与/更新：_src_order未=${missing._src_order}, _layer_group未=${missing._layer_group}, _style_key未=${missing._style_key}, _lock未=${missing._lock}`);
  }

  /* ===== export ===== */
  function collectTargetFeatures(){
    if($('#visible-only').checked && layerMap.size){
      const feats=[];
      layerOrder.forEach(k=>{
        const o=layerMap.get(k);
        if(!o) return;
        if(map.hasLayer(o.layer)){
          o.layer.eachLayer(l=>{ if(l.feature) feats.push(l.feature); });
        }
      });
      return feats;
    }
    return fcAll.features;
  }

  function collectTargetFeaturesOrdered(){
    const preserve = $('#preserve-order').checked;
    if(!preserve || !layerMap.size || !layerOrder.length){
      return collectTargetFeatures();
    }
    const visibleOnly = $('#visible-only').checked;
    const feats = [];
    for(const k of layerOrder){
      const o = layerMap.get(k);
      if(!o) continue;
      if(visibleOnly && !map.hasLayer(o.layer)) continue;
      const arr = [...(o.feats||[])].sort((a,b)=>{
        const ao=(a.properties&&a.properties._ord)||0;
        const bo=(b.properties&&b.properties._ord)||0;
        return ao-bo;
      });
      feats.push(...arr);
    }
    return feats;
  }

  function writeBackStyleProps(f){
    const sw=Number($('#stroke-width').value||2);
    const so=Math.max(0,Math.min(1,Number($('#stroke-op').value||1)));
    const fo=Math.max(0,Math.min(1,Number($('#fill-op').value||0.4)));
    const props=f.properties||(f.properties={});

    if(currentKey){
      const v=props[currentKey];
      const col= (v!=null && classifyMap.has(String(v))) ? classifyMap.get(String(v)) : '#1976d2';
      props.STROKE=col; props.FILL=col; props.WIDTH=sw; props.STROKE_OP=so; props.FILL_OP=fo;
    }

    if(layerKey){
      const lk = String(props[layerKey] ?? '');
      const idx = layerOrder.indexOf(lk);
      if(idx>=0){
        props.ZINDEX = (layerOrder.length - idx);
        props._layer = lk;
        props._layer_order = (idx + 1); // 1が最前面
      }
    }

    if(props._ord != null) props._seq = props._ord;
    return f;
  }

  function exportStyledSingle(){
    const src = collectTargetFeaturesOrdered();
    const feats = src.map(f=>writeBackStyleProps(JSON.parse(JSON.stringify(f))));
    const out={type:'FeatureCollection',features:feats};
    download(`styled_${timeStamp()}.geojson`, JSON.stringify(out));
  }

  function splitByCategory(){
    if(!currentKey){ setStatus('分類キーを設定してください'); return; }
    const source=collectTargetFeaturesOrdered();
    const groups=new Map();
    for(const f of source){
      const v=(f.properties||{})[currentKey];
      const k=String(v);
      const arr=groups.get(k)||[];
      arr.push(writeBackStyleProps(JSON.parse(JSON.stringify(f))));
      groups.set(k,arr);
    }
    for(const [k,arr] of groups.entries()){
      const out={type:'FeatureCollection',features:arr};
      const safe=k.replace(/[^\p{L}\p{N}_.-]+/gu,'_').slice(0,60)||'null';
      download(`split_${currentKey}_${safe}.geojson`, JSON.stringify(out));
    }
    setStatus(`分割エクスポート：${groups.size}ファイル`);
  }

  function dissolveByCategory(){
    if(!currentKey){ setStatus('分類キーを設定してください'); return; }
    const source=collectTargetFeaturesOrdered();
    const groups=new Map();
    for(const f of source){
      const v=(f.properties||{})[currentKey];
      const k=String(v);
      const arr=groups.get(k)||[];
      arr.push(f);
      groups.set(k,arr);
    }
    for(const [k,arr] of groups.entries()){
      let merged=null;
      const polys=arr.filter(x=>x.geometry&&(x.geometry.type==='Polygon'||x.geometry.type==='MultiPolygon'));
      if(polys.length){
        try{ merged=polys.slice(1).reduce((m,f)=>turf.union(m,f)||m,polys[0]); }
        catch{
          const coords=[];
          for(const p of polys){
            const g=p.geometry;
            if(g.type==='Polygon') coords.push(g.coordinates);
            else if(g.type==='MultiPolygon') coords.push(...g.coordinates);
          }
          merged={ type:'Feature', properties:{}, geometry:{ type:'MultiPolygon', coordinates:coords } };
        }
      }
      const others=arr.filter(x=>!x.geometry||(x.geometry.type!=='Polygon'&&x.geometry.type!=='MultiPolygon'));
      const outFeats=[];
      if(merged){
        merged.properties=Object.assign({},merged.properties,{[currentKey]:k});
        writeBackStyleProps(merged);
        outFeats.push(merged);
      }
      outFeats.push(...others.map(f=>{ const g=JSON.parse(JSON.stringify(f)); writeBackStyleProps(g); return g; }));
      const out={type:'FeatureCollection',features:outFeats};
      const safe=k.replace(/[^\p{L}\p{N}_.-]+/gu,'_').slice(0,60)||'null';
      download(`dissolve_${currentKey}_${safe}.geojson`, JSON.stringify(out));
    }
    setStatus('カテゴリ別 dissolve を出力しました');
  }

  function exportLegendCsv(){
    const sw=Number($('#stroke-width').value||2);
    const so=Number($('#stroke-op').value||1);
    const fo=Number($('#fill-op').value||0.4);
    const lines=[['key','value','color','WIDTH','STROKE_OP','FILL_OP']];
    for(const [k,c] of classifyMap.entries()) lines.push([currentKey,k,c,sw,so,fo]);
    const csv=lines.map(r=>r.map(x=>`"${String(x).replace(/"/g,'""')}"`).join(',')).join('\r\n');
    download(`legend_${currentKey}_${timeStamp()}.csv`, new Blob([csv],{type:'text/csv'}));
  }

  /* ===== load ===== */
  function readFileText(file){
    return new Promise((resolve,reject)=>{
      const r=new FileReader();
      r.onload=()=> resolve(r.result);
      r.onerror=reject;
      r.readAsText(file);
    });
  }
  function flattenFC(gj){
    const out=[]; const pushF=f=>{ if(!f||!f.geometry) return; out.push(f); };
    if(!gj) return out;
    if(gj.type==='Feature') pushF(gj);
    else if(gj.type==='FeatureCollection') (gj.features||[]).forEach(pushF);
    else if(gj.type && gj.coordinates) out.push({type:'Feature',properties:{},geometry:gj});
    return out;
  }

  async function handleFiles(files){
    const append=$('#append-mode').checked;
    const tagSrc=$('#tag-source').checked;

    setStatus(`読込（${files.length}件）… モード=${append?'追加':'置換'}`);
    const feats= append? [...fcAll.features] : [];
    let added=0;

    // ★ V23: 今回読み込むファイル群に対し、_src_order を付ける（同一ファイル内は同じ番号）
    // append=置換 のときは srcOrderSeq をリセットしても良いが、「セッション内」を優先し維持する
    for(const f of files){
      let thisSrcOrder = ++srcOrderSeq;

      try{
        const name=f.name||'';
        const tag=stem(name);

        if(/\.(geo)?json$/i.test(name)){
          const txt=await readFileText(f);
          const gj=JSON.parse(txt);
          const arr=flattenFC(gj);

          for(const ft of arr){
            const p=ft.properties||(ft.properties={});
            if(p._ord==null) p._ord=++ordSeq;
            if(tagSrc && p._src==null) p._src=tag;

            // ★ 正規化キー（最低限）
            if(p._src_order==null) p._src_order=thisSrcOrder;
            if(p._lock==null) p._lock='read';
            if(p._layer_group==null) p._layer_group=String(p._src ?? tag ?? '');
            if(p._style_key==null){
              const ck = ($('#class-key').value||'').trim();
              p._style_key = ck ? String(p[ck] ?? '') : '';
            }
          }
          feats.push(...arr); added+=arr.length;

        } else if(/\.zip$/i.test(name)){
          const ab=await f.arrayBuffer();
          const gj=await shp(ab);
          const arr=flattenFC(gj);

          for(const ft of arr){
            const p=ft.properties||(ft.properties={});
            if(p._ord==null) p._ord=++ordSeq;
            if(tagSrc && p._src==null) p._src=tag;

            // ★ 正規化キー（最低限）
            if(p._src_order==null) p._src_order=thisSrcOrder;
            if(p._lock==null) p._lock='read';
            if(p._layer_group==null) p._layer_group=String(p._src ?? tag ?? '');
            if(p._style_key==null){
              const ck = ($('#class-key').value||'').trim();
              p._style_key = ck ? String(p[ck] ?? '') : '';
            }
          }
          feats.push(...arr); added+=arr.length;
        }
      }catch(e){
        console.error('load failed', f?.name, e);
      }
    }

    fcAll={type:'FeatureCollection',features:feats};
    setStatus(`読込完了：${added}件追加（合計 ${feats.length}件）`);
    refreshBase();

    if(!$('#class-key').value) buildKeyGuess();
    if(!$('#layer-key').value && fcAll.features[0]?.properties?._layer_group) $('#layer-key').value='_layer_group';
    if(!$('#layer-key').value && fcAll.features[0]?.properties?._src) $('#layer-key').value='_src';
  }

  /* ===== expose ===== */
  window.AppCore = {
    // state
    get fcAll(){ return fcAll; },
    set fcAll(v){ fcAll=v; },
    get classifyMap(){ return classifyMap; },
    set classifyMap(v){ classifyMap=v; },
    get currentKey(){ return currentKey; },
    set currentKey(v){ currentKey=v; },
    get layerKey(){ return layerKey; },
    set layerKey(v){ layerKey=v; },
    get layerMap(){ return layerMap; },
    get layerOrder(){ return layerOrder; },
    set layerOrder(v){ layerOrder=v; },
    get undoBuffer(){ return undoBuffer; },
    set undoBuffer(v){ undoBuffer=v; },

    // functions
    setStatus, download, escapeHtml, timeStamp, normStr, parseList,
    refreshBase, styleOf,
    buildLayers, clearLayers, applyOrder, exportOrderCsv,
    previewDelete, execDelete, undoOnce,
    tryRestoreStyle, buildClassifyTable, updateLegend, applyDefaults,
    previewNormalize, doNormalize, ensureNormalizedKeys,
    exportStyledSingle, splitByCategory, dissolveByCategory, exportLegendCsv,
    handleFiles,
  };
})();
