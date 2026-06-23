if (window.innerWidth < 768 && !new URLSearchParams(location.search).has('desktop')) {
  const m = location.pathname.match(/^\/projects\/([^/]+)/);
  location.replace(m ? `/mobile#project/${m[1]}` : '/mobile');
}
