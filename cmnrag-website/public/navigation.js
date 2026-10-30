/* Shared navigation: native disclosure works before login and without this script. */
(() => {
  const menus = () => document.querySelectorAll('#auth-bar .nav-disclosure[open]');
  const close = (menu, restoreFocus = false) => {
    menu.open = false;
    if (restoreFocus) menu.querySelector('summary').focus();
  };

  document.addEventListener('click', (event) => {
    menus().forEach((menu) => {
      if (!menu.closest('.nav-menu').contains(event.target)) close(menu);
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menus().length) return;
    menus().forEach((menu) => close(menu, true));
    event.preventDefault();
  });

  document.addEventListener('focusout', (event) => {
    const group = event.target.closest('#auth-bar .nav-menu');
    if (group && !group.contains(event.relatedTarget)) {
      const menu = group.querySelector('.nav-disclosure');
      if (menu) close(menu);
    }
  });

  // Keep desktop hover while leaving touch interaction to the native summary.
  document.addEventListener('pointerover', (event) => {
    if (event.pointerType !== 'mouse' || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    const group = event.target.closest('#auth-bar .nav-menu');
    if (group && !group.contains(event.relatedTarget)) {
      group.querySelector('.nav-disclosure').open = true;
    }
  });
  document.addEventListener('pointerout', (event) => {
    if (event.pointerType !== 'mouse') return;
    const group = event.target.closest('#auth-bar .nav-menu');
    if (group && !group.contains(event.relatedTarget) && !group.contains(document.activeElement)) {
      close(group.querySelector('.nav-disclosure'));
    }
  });
})();
