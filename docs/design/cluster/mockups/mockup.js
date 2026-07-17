// 多机切换原型 共享脚本：机器切换器下拉 + 当前机器持久化（localStorage）+ 页头/面包屑联动。
// 每个页面是独立 HTML，导航用 <a href> 真跳转；当前机器跨页保持（演示全局 currentNode）。
(function(){
  var NODES = {
    '公司工作站': { dot:'on',  meta:'12ms · 3 会话' },
    '家里台式机': { dot:'on',  meta:'45ms · 1 会话' },
    '云 GPU 机':  { dot:'lag', meta:'88ms · 0 会话' }
  };
  var NAMES = { overview:'概览', projects:'项目', files:'文件', browser:'浏览器',
                phone:'手机', nodes:'机器', plugins:'插件', settings:'设置' };

  function apply(name){
    var n = NODES[name] || NODES['公司工作站'];
    var cls = 'dot ' + n.dot;
    var chipName = document.getElementById('chipName'); if (chipName) chipName.textContent = name;
    var chipDot = document.getElementById('chipDot');   if (chipDot) chipDot.className = cls;
    var crumbDot = document.getElementById('crumbDot'); if (crumbDot) crumbDot.className = cls;
    document.querySelectorAll('.js-machine').forEach(function(s){ s.textContent = name; });
    document.querySelectorAll('#dd .dd-item').forEach(function(it){
      var nm = it.querySelector('.nm');
      it.classList.toggle('cur', !!nm && nm.textContent === name);
    });
  }

  window.toggleDD = function(e){ e.stopPropagation(); document.getElementById('dd').classList.toggle('hide'); };
  window.pickNode = function(name){
    try { localStorage.setItem('roam.mock.node', name); } catch(_){}
    apply(name);
    document.getElementById('dd').classList.add('hide');
  };

  document.addEventListener('click', function(){
    var dd = document.getElementById('dd'); if (dd) dd.classList.add('hide');
  });

  document.addEventListener('DOMContentLoaded', function(){
    // 面包屑页名 + 侧栏高亮：来自 <body data-page="...">
    var page = document.body.getAttribute('data-page');
    var cp = document.getElementById('crumbPage'); if (cp && NAMES[page]) cp.textContent = NAMES[page];
    document.querySelectorAll('#nav a').forEach(function(a){
      a.classList.toggle('active', a.getAttribute('data-k') === page);
    });
    // 恢复上次选择的机器（跨页保持）
    var saved; try { saved = localStorage.getItem('roam.mock.node'); } catch(_){}
    apply(saved || '公司工作站');
  });
})();
