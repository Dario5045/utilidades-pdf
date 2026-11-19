(() => {
  document.querySelectorAll('[data-email-user][data-email-domain]').forEach((el) => {
    const usuario = el.dataset.emailUser?.trim();
    const dominio = el.dataset.emailDomain?.trim();
    if (!usuario || !dominio) return;

    const enlace = document.createElement('a');
    enlace.href = `mailto:${encodeURIComponent(usuario)}@${encodeURIComponent(dominio)}`;
    enlace.textContent = `${usuario}@${dominio}`;
    el.replaceChildren(enlace);
  });
})();