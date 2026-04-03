/* app.recipe.js */
(function(){
  "use strict";
  const $ = s => document.querySelector(s);

  function safeParseJson(text){
    try{ return {ok:true, json: JSON.parse(text)}; }
    catch(e){ return {ok:false, error:String(e)}; }
  }

  // 現在の状態を recipe として抜き取る
  function exportRecipe(){
    const core = window.AppCore;

    const recipe = {
      version: "23",
      meta: {
        createdAt: new Date().toISOString(),
        note: "統合or分割ツール V23 recipe",
      },

      normalize: {
        layerGroupFrom: ($('#norm-layer-group-from').value||'_src').trim() || '_src',
        lockDefault: $('#norm-lock-default').value || 'read',
        styleKeyMode: $('#norm-style-key-mode').value || 'classValue',
        srcOrderMode: $('#norm-src-order-mode').value || 'keep',
      },

      classify: {
        classKey: ($('#class-key').value||'').trim(),
        strokeWidth: Number($('#stroke-width').value||2),
        strokeOpacity: Number($('#stroke-op').value||1),
        fillOpacity: Number($('#fill-op').value||0.4),
        // value -> color
        map: Object.fromEntries(core.classifyMap.entries()),
      },

      layer: {
        layerKey: ($('#layer-key').value||'').trim(),
        order: core.layerOrder.slice(),
      },

      // V22拡張部（キー統合/カテゴリ統合/色CSV等）は ui 側で状態保持し、ここで合体
      advanced: window.AppUI?.exportAdvancedState?.() || {},
    };

    return recipe;
  }

  function applyRecipeToUI(recipe){
    // UIへ反映
    if(recipe?.normalize){
      $('#norm-layer-group-from').value = recipe.normalize.layerGroupFrom ?? '_src';
      $('#norm-lock-default').value = recipe.normalize.lockDefault ?? 'read';
      $('#norm-style-key-mode').value = recipe.normalize.styleKeyMode ?? 'classValue';
      $('#norm-src-order-mode').value = recipe.normalize.srcOrderMode ?? 'keep';
    }
    if(recipe?.classify){
      $('#class-key').value = recipe.classify.classKey ?? '';
      $('#stroke-width').value = String(recipe.classify.strokeWidth ?? 2);
      $('#stroke-op').value = String(recipe.classify.strokeOpacity ?? 1);
      $('#fill-op').value = String(recipe.classify.fillOpacity ?? 0.4);
    }
    if(recipe?.layer){
      $('#layer-key').value = recipe.layer.layerKey ?? '';
    }

    // advanced をUIへ
    if(window.AppUI?.applyAdvancedState && recipe?.advanced){
      window.AppUI.applyAdvancedState(recipe.advanced);
    }
  }

  function applyRecipe(recipe){
    const core = window.AppCore;

    // 1) UIへ反映
    applyRecipeToUI(recipe);

    // 2) 正規化キー付与/更新
    core.doNormalize();

    // 3) 分類マップ反映
    const mapObj = recipe?.classify?.map || {};
    core.currentKey = (recipe?.classify?.classKey || '').trim();
    core.classifyMap = new Map(Object.entries(mapObj));

    // 4) 地図反映＆凡例
    core.updateLegend();
    if(core.layerMap.size){
      core.layerMap.forEach(o=>o.layer.setStyle(core.styleOf));
    }else{
      core.refreshBase();
    }

    // 5) レイヤ順の復元（レイヤ構築済なら順序適用、未構築なら order を保存しておく）
    if(Array.isArray(recipe?.layer?.order)){
      core.layerOrder = recipe.layer.order.slice();
      if(core.layerMap.size){
        core.applyOrder();
      }
      if(window.AppUI?.buildOrderList) window.AppUI.buildOrderList();
    }

    // 6) advanced の適用（キー統合/カテゴリ統合/色CSV等）
    if(window.AppUI?.applyAdvancedByRecipe){
      window.AppUI.applyAdvancedByRecipe(recipe?.advanced || {});
    }

    // 最後に再描画
    core.refreshBase();
    core.setStatus('レシピを適用しました（自動処理）');
  }

  async function loadRecipeFromFile(file){
    const text = await file.text();
    const r = safeParseJson(text);
    if(!r.ok) throw new Error(`JSON parse error: ${r.error}`);
    return r.json;
  }

  function recipePreviewBox(recipe){
    const box = $('#recipe-preview');
    box.style.display='block';
    box.textContent = JSON.stringify(recipe, null, 2);
  }

  // expose
  window.AppRecipe = {
    exportRecipe,
    applyRecipe,
    applyRecipeToUI,
    loadRecipeFromFile,
    recipePreviewBox,
  };
})();
