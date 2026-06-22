if (window.innerWidth < 768 && !new URLSearchParams(location.search).has('desktop'))
  location.replace('/mobile');
