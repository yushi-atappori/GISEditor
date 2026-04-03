/* app.ui.js : V22完全移植 + V23 recipe対応 */
(function(){
  "use strict";
  const $ = s => document.querySelector(s);
  const core = window.AppCore;

  /* =========================================================
     凡例リサイズ・パネル制御（前回提示と同一）
     ========================================================= */
  function resizeLegend(){
    const legendItems = $('#legend-items');
    const legendBody = $('#legend-body');
    const minVH = 12, maxVH = 45;
    const itemH = legendItems.scrollHeight + 12;
    const vh = Math.max(minVH, Math.min(maxVH, (itemH / window.innerHeight) * 100));
    legendBody.style.maxHeight = vh + 'vh';
  }
  window.addEventListener('resize', resizeLegend);

  function makeDraggableFixed(box, head, storageKey, defaultPos){
    let saved=null;
    try{ saved = JSON.parse(localStorage.getItem(storageKey)||'null'); }catch{}
    const valid=v=>typeof v==='number' && isFinite(v);
    const x=valid(saved?.x)?saved.x:defaultPos.x;
    const y=valid(saved?.y)?saved.y:defaultPos.y;
    const min=typeof saved?.min==='boolean'?saved.min:false;

    box.style.left=x+'px'; box.style.top=y+'px';
    box.classList.toggle('minimized',min);
    box.setAttribute('aria-expanded',(!min).toString());

    let drag=false,sx,sy,bx,by;
    head.addEventListener('pointerdown',e=>{
      if(e.target.closest('button'))return;
      drag=true;head.setPointerCapture(e.pointerId);
      sx=e.clientX;sy=e.clientY;
      const r=box.getBoundingClientRect();bx=r.left;by=r.top;
    });
    head.addEventListener('pointermove',e=>{
      if(!drag)return;
      box.style.left=Math.max(0,bx+e.clientX-sx)+'px';
      box.style.top =Math.max(0,by+e.clientY-sy)+'px';
    });
    head.addEventListener('pointerup',e=>{
      if(!drag)return;
      drag=false;head.releasePointerCapture(e.pointerId);save();
    });
    head.addEventListener('dblclick',e=>{
      if(e.target.closest('button'))return;
      toggle();
    });
    function toggle(){
      const m=!box.classList.contains('minimized');
      box.classList.toggle('minimized',m);
      box.setAttribute('aria-expanded',(!m).toString());
      save();
    }
    function save(){
      const r=box.getBoundingClientRect();
      localStorage.setItem(storageKey,JSON.stringify({x:r.left,y:r.top,min:box.classList.contains('minimized')}));
    }
    return toggle;
  }

  makeDraggableFixed($('#panel'),$('#panel-head'),'panel_v23',{x:10,y:10});
  makeDraggableFixed($('#legend'),$('#legend-head'),'legend_v23',{x:340,y:20});

  /* =========================================================
     V22 移植①：キー統合（属性名統一）
     ========================================================= */

  let unifyRules = []; // [{from:'A29_001', to:'YoutoName'}]

  function applyKeyUnify(){
    unifyRules.forEach(r=>{
      core.fcAll.features.forEach(f=>{
        const p=f.properties||{};
        if(p[r.from]!=null && p[r.to]==null){
          p[r.to]=p[r.from];
        }
      });
    });
    core.refreshBase();
    core.setStatus('キー統合を適用しました');
  }

  /* =========================================================
     V22 移植②：カテゴリ統合（値統一）
     ========================================================= */

  let categoryMerge = {}; 
  // { '第一種低層住居専用地域': '住居系', '第二種低層住居専用地域':'住居系' }

  function applyCategoryMerge(){
    const key=$('#class-key').value;
    core.fcAll.features.forEach(f=>{
      const p=f.properties||{};
      const v=p[key];
      if(v!=null && categoryMerge[v]!=null){
        p[key]=categoryMerge[v];
      }
    });
    core.refreshBase();
    core.setStatus('カテゴリ統合を適用しました');
  }

  /* =========================================================
     V22 移植③：色CSV適用
     ========================================================= */

  let colorCsvMap = {}; // {値: '#rrggbb'}

  function applyColorCsv(){
    Object.entries(colorCsvMap).forEach(([k,c])=>{
      core.classifyMap.set(k,c);
    });
    core.updateLegend();
    core.refreshBase();
    core.setStatus('色CSVを適用しました');
  }

  /* =========================================================
     V23 レシピ対応（★重要）
     ========================================================= */

  function exportAdvancedState(){
    return {
      unifyRules,
      categoryMerge,
      colorCsvMap
    };
  }

  function applyAdvancedState(obj){
    unifyRules = obj.unifyRules || [];
    categoryMerge = obj.categoryMerge || {};
    colorCsvMap = obj.colorCsvMap || {};
  }

  function applyAdvancedByRecipe(obj){
    applyAdvancedState(obj);
    applyKeyUnify();
    applyCategoryMerge();
    applyColorCsv();
  }

  /* =========================================================
     UIイベント（V22＋V23）
     ========================================================= */

  $('#btn-build-layers').onclick=core.buildLayers;
  $('#btn-apply-order').onclick=core.applyOrder;
  $('#btn-classify').onclick=core.buildClassifyTable;
  $('#btn-apply-style').onclick=()=>core.refreshBase();
  $('#btn-restore-style').onclick=core.tryRestoreStyle;

  $('#btn-normalize').onclick=core.doNormalize;
  $('#btn-normalize-preview').onclick=core.previewNormalize;

  $('#btn-export-styled').onclick=core.exportStyledSingle;
  $('#btn-export-percat').onclick=core.splitByCategory;
  $('#btn-export-dissolved').onclick=core.dissolveByCategory;
  $('#btn-export-legend').onclick=core.exportLegendCsv;

  /* =========================================================
     expose（recipe が参照）
     ========================================================= */
  window.AppUI = {
    resizeLegend,
    exportAdvancedState,
    applyAdvancedState,
    applyAdvancedByRecipe,
    buildOrderList:()=>{}
  };

  resizeLegend();
})();
