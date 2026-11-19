(() => {
  const { PDFDocument } = window.PDFLib || {};

  // ==========================================================
  // Seguridad y Clases de Error Personalizadas
  // ==========================================================
  class LimiteError extends Error {
    constructor(message) {
      super(message);
      this.name = 'LimiteError';
      this.mostrar = true;
    }
  }

  const LIMITES_SEGURIDAD = {
    MAX_PAGINAS_COMPRIMIR: 100,                // Comprimir rasteriza cada página: es costoso
    MAX_BYTES_ARCHIVO: 50 * 1024 * 1024,       // 50 MB máximo por archivo individual
    MAX_BYTES_TOTAL_UNIR: 150 * 1024 * 1024,   // 150 MB máximo acumulado al unir
    MAX_ARCHIVOS_UNIR: 20,                     // Máximo 20 archivos en cola
    MAX_PAGINAS_DOCUMENTO: 500,                // Límite de páginas para evitar agotamiento de RAM
    MAX_ARCHIVOS_DESCARGA_INDIVIDUAL: 50,      // Evita bloqueo del navegador al descargar página por página
    MAX_PIXELES_CANVAS: 16000000,              // Safari iOS falla por encima de ~16,7 M píxeles por canvas
  };

  // Firma binaria oficial de la especificación PDF: "%PDF-" (0x25 0x50 0x44 0x46 0x2D)
  const PDF_MAGIC_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d];

  // ==========================================================
  // Sanitización de texto
  // ==========================================================
  function sanitizarTexto(entrada, maxLongitud = 180) {
    const limpio = String(entrada ?? '')
      .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '')
      .trim();

    if (limpio.length <= maxLongitud) return limpio;
    return `${limpio.slice(0, maxLongitud - 1)}…`;
  }

  function sanitizarNombreArchivo(nombre, fallback = 'documento') {
    const base = sanitizarTexto(nombre, 120)
      .replace(/\.pdf$/i, '')
      .replace(/[<>:"/\\|?*]+/g, '_')
      .replace(/\.{2,}/g, '.')
      .replace(/^\.+|\.+$/g, '');

    return base || fallback;
  }

  function asignarTextoSeguro(elemento, texto, maxLongitud = 220) {
    const textoLimpio = sanitizarTexto(texto, maxLongitud);
    elemento.textContent = textoLimpio;
    return textoLimpio;
  }

  // ==========================================================
  // Validación estricta de MIME, extensión y firma real
  // ==========================================================
  async function validarArchivoPDFEstricto(file) {
    if (!(file instanceof File)) {
      return { valido: false, motivo: 'El elemento proporcionado no es un archivo válido.' };
    }

    const nombreSeguro = sanitizarTexto(file.name, 80);

    if (file.size === 0) {
      return { valido: false, motivo: `"${nombreSeguro}" está vacío (0 bytes).` };
    }

    if (file.size > LIMITES_SEGURIDAD.MAX_BYTES_ARCHIVO) {
      return {
        valido: false,
        motivo: `"${nombreSeguro}" (${formatBytes(file.size)}) supera el límite máximo permitido de ${formatBytes(LIMITES_SEGURIDAD.MAX_BYTES_ARCHIVO)}.`,
      };
    }

    const nombreMinusculas = file.name.trim().toLowerCase();
    if (!nombreMinusculas.endsWith('.pdf')) {
      return {
        valido: false,
        motivo: `"${nombreSeguro}" no tiene una extensión .pdf válida.`,
      };
    }

    const mimesPermitidos = new Set(['application/pdf', 'application/x-pdf', 'application/octet-stream', '']);
    if (!mimesPermitidos.has(file.type)) {
      return {
        valido: false,
        motivo: `"${nombreSeguro}" tiene un tipo MIME no permitido (${sanitizarTexto(file.type, 40)}). Solo se aceptan documentos PDF reales.`,
      };
    }

    try {
      const cabeceraBuffer = await file.slice(0, 1024).arrayBuffer();
      const cabeceraBytes = new Uint8Array(cabeceraBuffer);

      if (cabeceraBytes.length < 8) {
        return { valido: false, motivo: `"${nombreSeguro}" está corrupto o truncado.` };
      }

      let offsetFirma = -1;
      for (let i = 0; i <= cabeceraBytes.length - PDF_MAGIC_BYTES.length; i++) {
        const coincide = PDF_MAGIC_BYTES.every((byte, idx) => cabeceraBytes[i + idx] === byte);
        if (coincide) {
          offsetFirma = i;
          break;
        }
      }

      if (offsetFirma === -1) {
        return {
          valido: false,
          motivo: `"${nombreSeguro}" fue rechazado: su contenido binario no corresponde a un PDF auténtico.`,
        };
      }

      const textoCabecera = new TextDecoder('ascii').decode(
        cabeceraBytes.slice(offsetFirma, offsetFirma + 10)
      );
      if (!/^%PDF-[12]\.\d/.test(textoCabecera)) {
        return {
          valido: false,
          motivo: `"${nombreSeguro}" no posee una cabecera de versión PDF reconocida.`,
        };
      }

      const inicioCola = Math.max(0, file.size - 65536);
      const colaBuffer = await file.slice(inicioCola, file.size).arrayBuffer();
      const textoCola = new TextDecoder('latin1').decode(new Uint8Array(colaBuffer));

      if (!textoCola.includes('%%EOF')) {
        return {
          valido: false,
          motivo: `"${nombreSeguro}" está incompleto o dañado (falta marcador de cierre EOF).`,
        };
      }
    } catch {
      return {
        valido: false,
        motivo: `No se pudo inspeccionar la integridad binaria de "${nombreSeguro}".`,
      };
    }

    return { valido: true };
  }

  // ==========================================================
  // Utilidades compartidas
  // ==========================================================
  function formatBytes(bytes) {
    const num = Number(bytes);
    if (!Number.isFinite(num) || num < 0) return '0 B';
    if (num < 1024) return `${num} B`;
    if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
    return `${(num / (1024 * 1024)).toFixed(2)} MB`;
  }

  function esperarRenderizado() {
    return new Promise((resolve) => {
      let hecho = false;
      const fin = () => { if (!hecho) { hecho = true; resolve(); } };
      requestAnimationFrame(() => setTimeout(fin, 20));
      setTimeout(fin, 150);
    });
  }

  function setButtonLoading(button, isLoading, textoCargando, textoNormal) {
    const label = button.querySelector('.btn-label');
    button.classList.toggle('is-loading', isLoading);
    button.setAttribute('aria-busy', String(isLoading));
    if (isLoading) {
      button.disabled = true;
      if (label && textoCargando) asignarTextoSeguro(label, textoCargando, 60);
    } else if (label && textoNormal) {
      asignarTextoSeguro(label, textoNormal, 60);
    }
  }

  async function guardarPDFOptimizado(pdfDoc) {
    pdfDoc.setProducer('');
    pdfDoc.setCreator('');

    return pdfDoc.save({
      useObjectStreams: true,
      addDefaultPage: false,
      objectsPerTick: 100,
      updateFieldAppearances: false,
    });
  }

  function descargarPDF(bytes, nombreArchivo) {
    descargarBlob(
      new Blob([bytes], { type: 'application/pdf' }),
      `${sanitizarNombreArchivo(nombreArchivo)}.pdf`
    );
  }

  function descargarBlob(blob, nombreSeguro) {
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement('a');

    enlace.href = url;
    enlace.download = nombreSeguro;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();

    // Aumentado a 45 s para dar seguridad a Safari con archivos grandes
    setTimeout(() => URL.revokeObjectURL(url), 45000);
  }

  // ==========================================================
  // 1. UNIR PDF
  // ==========================================================
  const inputUnir = document.getElementById('file-unir');
  const listUnir = document.getElementById('list-unir');
  const btnUnir = document.getElementById('btn-unir');
  const statusUnir = document.getElementById('status-unir');

  let archivosSeleccionados = [];
  let ocupadoUnir = false;

  function bloquearUnir(valor) {
    ocupadoUnir = valor;
    inputUnir.disabled = valor;
    listUnir.inert = valor;
  }

  function setStatusUnir(mensaje, tipo = 'normal') {
    asignarTextoSeguro(statusUnir, mensaje, 260);
    statusUnir.classList.toggle('is-error', tipo === 'error');
    statusUnir.classList.toggle('is-loading', tipo === 'loading');
  }

  function renderListaUnir(mensajeAviso = null) {
    listUnir.replaceChildren();

    archivosSeleccionados.forEach((file, index) => {
      const nombreSeguro = sanitizarTexto(file.name, 140);
      const li = document.createElement('li');

      const info = document.createElement('div');
      info.className = 'file-info';

      const badge = document.createElement('span');
      badge.className = 'file-index';
      asignarTextoSeguro(badge, String(index + 1), 10);

      const name = document.createElement('span');
      name.className = 'file-name';
      asignarTextoSeguro(name, nombreSeguro, 140);
      name.title = nombreSeguro;

      const size = document.createElement('span');
      size.className = 'file-size';
      asignarTextoSeguro(size, formatBytes(file.size), 30);

      info.append(badge, name, size);

      const controls = document.createElement('div');
      controls.className = 'file-controls';

      const btnUp = document.createElement('button');
      btnUp.type = 'button';
      btnUp.className = 'icon-btn';
      btnUp.textContent = '↑';
      btnUp.title = 'Subir posición';
      btnUp.setAttribute('aria-label', `Subir ${nombreSeguro}`);
      btnUp.disabled = index === 0;
      btnUp.addEventListener('click', () => moverArchivo(index, -1));

      const btnDown = document.createElement('button');
      btnDown.type = 'button';
      btnDown.className = 'icon-btn';
      btnDown.textContent = '↓';
      btnDown.title = 'Bajar posición';
      btnDown.setAttribute('aria-label', `Bajar ${nombreSeguro}`);
      btnDown.disabled = index === archivosSeleccionados.length - 1;
      btnDown.addEventListener('click', () => moverArchivo(index, 1));

      const btnRemove = document.createElement('button');
      btnRemove.type = 'button';
      btnRemove.className = 'icon-btn danger';
      btnRemove.textContent = '✕';
      btnRemove.title = 'Quitar archivo';
      btnRemove.setAttribute('aria-label', `Quitar ${nombreSeguro}`);
      btnRemove.addEventListener('click', () => eliminarArchivo(index));

      controls.append(btnUp, btnDown, btnRemove);
      li.append(info, controls);
      listUnir.appendChild(li);
    });

    btnUnir.disabled = archivosSeleccionados.length < 2;

    if (mensajeAviso) {
      setStatusUnir(mensajeAviso, 'error');
      return;
    }

    if (archivosSeleccionados.length === 1) {
      setStatusUnir('Añade al menos un archivo PDF más para poder unirlos.');
    } else if (archivosSeleccionados.length >= 2) {
      const pesoTotal = archivosSeleccionados.reduce((acc, f) => acc + f.size, 0);
      setStatusUnir(`${archivosSeleccionados.length} archivos (${formatBytes(pesoTotal)}) listos para combinar.`);
    } else {
      setStatusUnir('');
    }
  }

  function moverArchivo(index, direccion) {
    const nuevoIndex = index + direccion;
    if (nuevoIndex < 0 || nuevoIndex >= archivosSeleccionados.length) return;

    const [movido] = archivosSeleccionados.splice(index, 1);
    archivosSeleccionados.splice(nuevoIndex, 0, movido);
    renderListaUnir();
  }

  function eliminarArchivo(index) {
    archivosSeleccionados.splice(index, 1);
    renderListaUnir();
  }

  inputUnir.addEventListener('change', async (e) => {
    const candidatos = Array.from(e.target.files || []);
    inputUnir.value = '';
    if (candidatos.length === 0) return;

    setStatusUnir('Verificando autenticidad y tamaño de archivos...', 'loading');

    const validos = [];
    const errores = [];
    let pesoAcumulado = archivosSeleccionados.reduce((acc, f) => acc + f.size, 0);

    for (const archivo of candidatos) {
      if (archivosSeleccionados.length + validos.length >= LIMITES_SEGURIDAD.MAX_ARCHIVOS_UNIR) {
        errores.push(`Límite alcanzado: máximo ${LIMITES_SEGURIDAD.MAX_ARCHIVOS_UNIR} archivos por operación.`);
        break;
      }

      const resultado = await validarArchivoPDFEstricto(archivo);
      if (!resultado.valido) {
        errores.push(resultado.motivo);
        continue;
      }

      if (pesoAcumulado + archivo.size > LIMITES_SEGURIDAD.MAX_BYTES_TOTAL_UNIR) {
        errores.push(
          `Se superó el límite total de ${formatBytes(LIMITES_SEGURIDAD.MAX_BYTES_TOTAL_UNIR)} para evitar saturar el navegador.`
        );
        break;
      }

      pesoAcumulado += archivo.size;
      validos.push(archivo);
    }

    archivosSeleccionados.push(...validos);
    
    // Si varios archivos fallan, muestra el total de rechazados de forma agrupada
    let aviso = null;
    if (errores.length > 0) {
      if (errores.length === 1) {
        aviso = `${errores[0]}${validos.length ? ` Se añadieron ${validos.length} archivo(s) válido(s).` : ''}`;
      } else {
        aviso = `${errores.length} archivos rechazados. Primer error: ${errores[0]}${validos.length ? ` Se añadieron ${validos.length} válidos.` : ''}`;
      }
    }

    renderListaUnir(aviso);
  });

  btnUnir.addEventListener('click', async () => {
    if (archivosSeleccionados.length < 2) return;

    if (!PDFDocument) {
      setStatusUnir('No se pudo cargar la librería pdf-lib. Revisa tu conexión.', 'error');
      return;
    }

    if (ocupadoUnir) return;
    setButtonLoading(btnUnir, true, 'Uniendo archivos...', 'Unir archivos');
    bloquearUnir(true);
    const cola = [...archivosSeleccionados];
    setStatusUnir('Combinando y optimizando documentos...', 'loading');
    await esperarRenderizado();

    try {
      const pdfFinal = await PDFDocument.create();
      const total = cola.length;
      let paginasAcumuladas = 0;

      for (let i = 0; i < total; i++) {
        const archivo = cola[i];
        const nombreSeguro = sanitizarTexto(archivo.name, 80);
        setStatusUnir(`Procesando archivo ${i + 1} de ${total}: ${nombreSeguro}...`, 'loading');
        await esperarRenderizado();

        const arrayBuffer = await archivo.arrayBuffer();
        const pdfOrigen = await PDFDocument.load(arrayBuffer, { ignoreEncryption: false });
        const indicesPaginas = pdfOrigen.getPageIndices();

        paginasAcumuladas += indicesPaginas.length;
        if (paginasAcumuladas > LIMITES_SEGURIDAD.MAX_PAGINAS_DOCUMENTO) {
          throw new LimiteError(
            `El documento combinado supera el límite seguro de ${LIMITES_SEGURIDAD.MAX_PAGINAS_DOCUMENTO} páginas.`
          );
        }

        const paginasCopiadas = await pdfFinal.copyPages(pdfOrigen, indicesPaginas);
        paginasCopiadas.forEach((pagina) => pdfFinal.addPage(pagina));
      }

      setStatusUnir('Optimizando estructura y generando descarga...', 'loading');
      await esperarRenderizado();

      const pdfBytes = await guardarPDFOptimizado(pdfFinal);
      descargarPDF(pdfBytes, 'documento-unido.pdf');
      setStatusUnir(`¡Listo! Archivo combinado descargado (${formatBytes(pdfBytes.byteLength)}).`);
    } catch (error) {
      console.error('Error al unir PDF:', error);
      const mensaje = error instanceof LimiteError
        ? error.message
        : 'Ocurrió un error al procesar uno de los PDF (puede estar dañado, malformado o protegido con contraseña).';
      setStatusUnir(mensaje, 'error');
    } finally {
      bloquearUnir(false);
      setButtonLoading(btnUnir, false, '', 'Unir archivos');
      btnUnir.disabled = archivosSeleccionados.length < 2;
    }
  });

  // ==========================================================
  // 2. DIVIDIR PDF
  // ==========================================================
  const inputDividir = document.getElementById('file-dividir');
  const listDividir = document.getElementById('list-dividir');
  const inputRango = document.getElementById('rango');
  const radiosModoDividir = document.querySelectorAll('input[name="modo-dividir"]');
  const btnDividir = document.getElementById('btn-dividir');
  const statusDividir = document.getElementById('status-dividir');

  let estadoDividir = {
    file: null,
    pdfDoc: null,
    totalPaginas: 0,
  };

  function bloquearDividir(valor) {
    inputDividir.disabled = valor;
    listDividir.inert = valor;
    const opciones = document.querySelector('#panel-dividir .options');
    if (opciones) opciones.disabled = valor;
  }

  function setStatusDividir(mensaje, tipo = 'normal') {
    asignarTextoSeguro(statusDividir, mensaje, 260);
    statusDividir.classList.toggle('is-error', tipo === 'error');
    statusDividir.classList.toggle('is-loading', tipo === 'loading');
  }

  function obtenerModoDividir() {
    const seleccionado = document.querySelector('input[name="modo-dividir"]:checked');
    return seleccionado ? seleccionado.value : 'rango';
  }

  function parsearRangoPaginas(textoRango, totalPaginas) {
    const crudo = String(textoRango ?? '');
    if (crudo.length > 400) {
      throw new LimiteError('El rango es demasiado largo. Simplifica la lista de páginas (ej. 1-50, 60).');
    }
    const entradaLimpia = sanitizarTexto(crudo, 400);
    if (!entradaLimpia) {
      throw new LimiteError('Ingresa un rango de páginas (ejemplo: 1-3, 5).');
    }

    if (!/^[\d,\-\s]+$/.test(entradaLimpia)) {
      throw new LimiteError('Formato no válido. Usa únicamente números, guiones y comas (ej. 1-3, 5).');
    }

    const segmentos = entradaLimpia.split(',');
    const indicesSet = new Set();

    for (const seg of segmentos) {
      const parte = seg.trim();
      if (!parte) continue;

      if (parte.includes('-')) {
        const limites = parte.split('-').map((n) => n.trim());
        if (limites.length !== 2 || !/^\d+$/.test(limites[0]) || !/^\d+$/.test(limites[1])) {
          throw new LimiteError(`Formato inválido en "${parte}". Usa el formato inicio-fin (ej. 2-5).`);
        }

        const inicio = parseInt(limites[0], 10);
        const fin = parseInt(limites[1], 10);

        if (inicio < 1 || fin > totalPaginas) {
          throw new LimiteError(`El rango "${parte}" está fuera de límites (el PDF tiene ${totalPaginas} páginas).`);
        }
        if (inicio > fin) {
          throw new LimiteError(`En "${parte}", la página inicial (${inicio}) no puede ser mayor que la final (${fin}).`);
        }

        for (let p = inicio; p <= fin; p++) {
          indicesSet.add(p - 1);
        }
      } else {
        if (!/^\d+$/.test(parte)) {
          throw new LimiteError(`Valor inválido "${parte}". Solo se permiten números y guiones.`);
        }

        const pagina = parseInt(parte, 10);
        if (pagina < 1 || pagina > totalPaginas) {
          throw new LimiteError(`La página ${pagina} no existe (el PDF tiene ${totalPaginas} páginas).`);
        }

        indicesSet.add(pagina - 1);
      }
    }

    if (indicesSet.size === 0) {
      throw new LimiteError('No se encontraron páginas válidas en el rango ingresado.');
    }

    return Array.from(indicesSet);
  }

  function renderArchivoDividir() {
    listDividir.replaceChildren();

    if (!estadoDividir.file) {
      btnDividir.disabled = true;
      return;
    }

    const { file, totalPaginas } = estadoDividir;
    const nombreSeguro = sanitizarTexto(file.name, 140);
    const li = document.createElement('li');

    const info = document.createElement('div');
    info.className = 'file-info';

    const name = document.createElement('span');
    name.className = 'file-name';
    asignarTextoSeguro(name, nombreSeguro, 140);
    name.title = nombreSeguro;

    const meta = document.createElement('span');
    meta.className = 'file-size';
    asignarTextoSeguro(
      meta,
      `${totalPaginas} ${totalPaginas === 1 ? 'pág.' : 'págs.'} · ${formatBytes(file.size)}`,
      40
    );

    info.append(name, meta);

    const controls = document.createElement('div');
    controls.className = 'file-controls';

    const btnRemove = document.createElement('button');
    btnRemove.type = 'button';
    btnRemove.className = 'icon-btn danger';
    btnRemove.textContent = '✕';
    btnRemove.title = 'Quitar archivo';
    btnRemove.setAttribute('aria-label', `Quitar ${nombreSeguro}`);
    btnRemove.addEventListener('click', () => {
      estadoDividir = { file: null, pdfDoc: null, totalPaginas: 0 };
      inputDividir.value = '';
      inputRango.value = '';
      setStatusDividir('');
      renderArchivoDividir();
    });

    controls.append(btnRemove);
    li.append(info, controls);
    listDividir.appendChild(li);

    btnDividir.disabled = false;
  }

  function sincronizarEstadoRango() {
    const esRango = obtenerModoDividir() === 'rango';
    inputRango.disabled = !esRango;
  }

  radiosModoDividir.forEach((radio) => {
    radio.addEventListener('change', () => {
      sincronizarEstadoRango();
      if (obtenerModoDividir() === 'rango') inputRango.focus();
    });
  });

  // Sincronizar al cargar la página por si Firefox restaura el estado del radio previo
  sincronizarEstadoRango();

  inputDividir.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    inputDividir.value = '';
    if (!file) return;

    if (!PDFDocument) {
      setStatusDividir('No se pudo cargar la librería pdf-lib. Revisa tu conexión.', 'error');
      return;
    }

    setStatusDividir('Verificando integridad y estructura del PDF...', 'loading');
    btnDividir.disabled = true;
    await esperarRenderizado();

    const validacion = await validarArchivoPDFEstricto(file);
    if (!validacion.valido) {
      estadoDividir = { file: null, pdfDoc: null, totalPaginas: 0 };
      renderArchivoDividir();
      setStatusDividir(validacion.motivo, 'error');
      return;
    }

    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: false });
      const totalPaginas = pdfDoc.getPageCount();

      if (totalPaginas > LIMITES_SEGURIDAD.MAX_PAGINAS_DOCUMENTO) {
        throw new LimiteError(
          `El documento tiene ${totalPaginas} páginas y supera el límite seguro de ${LIMITES_SEGURIDAD.MAX_PAGINAS_DOCUMENTO} páginas.`
        );
      }

      estadoDividir = { file, pdfDoc, totalPaginas };
      renderArchivoDividir();

      inputRango.placeholder = totalPaginas > 1 ? `Ejemplo: 1-${Math.min(3, totalPaginas)}` : '1';
      setStatusDividir(`Documento verificado y cargado (${totalPaginas} ${totalPaginas === 1 ? 'página' : 'páginas'}).`);
    } catch (error) {
      console.error('Error al leer PDF:', error);
      estadoDividir = { file: null, pdfDoc: null, totalPaginas: 0 };
      renderArchivoDividir();
      const mensaje = error instanceof LimiteError
        ? error.message
        : 'No se pudo leer el PDF (puede estar dañado o protegido con contraseña).';
      setStatusDividir(mensaje, 'error');
    }
  });

  btnDividir.addEventListener('click', async () => {
    const { file, pdfDoc, totalPaginas } = estadoDividir;
    if (!file || !pdfDoc) return;

    const modo = obtenerModoDividir();
    const nombreBase = sanitizarNombreArchivo(file.name, 'documento');

    setButtonLoading(btnDividir, true, 'Procesando...', 'Dividir archivo');
    bloquearDividir(true);
    setStatusDividir('Extrayendo y optimizando páginas...', 'loading');
    await esperarRenderizado();

    try {
      if (modo === 'rango') {
        const indices = parsearRangoPaginas(inputRango.value, totalPaginas);
        const nuevoPdf = await PDFDocument.create();
        const paginasCopiadas = await nuevoPdf.copyPages(pdfDoc, indices);

        paginasCopiadas.forEach((pagina) => nuevoPdf.addPage(pagina));

        const pdfBytes = await guardarPDFOptimizado(nuevoPdf);
        descargarPDF(pdfBytes, `${nombreBase}-extraido.pdf`);
        setStatusDividir(
          `¡Listo! Se extrajeron ${indices.length} ${indices.length === 1 ? 'página' : 'páginas'} (${formatBytes(pdfBytes.byteLength)}).`
        );
      } else {
        if (totalPaginas > LIMITES_SEGURIDAD.MAX_ARCHIVOS_DESCARGA_INDIVIDUAL) {
          throw new LimiteError(
            `Para evitar bloquear tu navegador, la descarga individual está limitada a ${LIMITES_SEGURIDAD.MAX_ARCHIVOS_DESCARGA_INDIVIDUAL} páginas. Usa la extracción por rango.`
          );
        }

        const Zip = window.JSZip;
        if (!Zip) throw new LimiteError('No se pudo cargar la librería JSZip. Revisa tu conexión.');
        const zip = new Zip();

        for (let i = 0; i < totalPaginas; i++) {
          setStatusDividir(`Generando página ${i + 1} de ${totalPaginas}...`, 'loading');
          await esperarRenderizado();

          const pdfPagina = await PDFDocument.create();
          const [paginaCopiada] = await pdfPagina.copyPages(pdfDoc, [i]);
          pdfPagina.addPage(paginaCopiada);

          const pdfBytes = await guardarPDFOptimizado(pdfPagina);
          zip.file(`${nombreBase}-pagina-${i + 1}.pdf`, pdfBytes);
        }

        setStatusDividir('Empaquetando archivos en un ZIP...', 'loading');
        await esperarRenderizado();
        descargarBlob(await zip.generateAsync({ type: 'blob' }), `${nombreBase}-paginas.zip`);
        setStatusDividir(`¡Listo! Se descargó un ZIP con ${totalPaginas} archivos.`);
      }
    } catch (error) {
      console.error('Error al dividir PDF:', error);
      setStatusDividir(
        error instanceof LimiteError ? error.message : 'Ocurrió un error al dividir el archivo.',
        'error'
      );
    } finally {
      bloquearDividir(false);
      setButtonLoading(btnDividir, false, '', 'Dividir archivo');
      btnDividir.disabled = !estadoDividir.file;
    }
  });

  // ==========================================================
  // 3. COMPRIMIR PDF
  // ==========================================================
  const PDFJS_WORKER_URL = '/vendor/pdf.worker.min.js';
  const NIVELES_COMPRESION = {
    baja: { escala: 2, calidad: 0.8 },
    media: { escala: 1.5, calidad: 0.65 },
    alta: { escala: 1, calidad: 0.5 },
  };

  const inputComprimir = document.getElementById('file-comprimir');
  const listComprimir = document.getElementById('list-comprimir');
  const btnComprimir = document.getElementById('btn-comprimir');
  const statusComprimir = document.getElementById('status-comprimir');

  let archivoComprimir = null;
  let workerBlobUrl = null;

  function bloquearComprimir(valor) {
    inputComprimir.disabled = valor;
    listComprimir.inert = valor;
    const opciones = document.querySelector('#panel-comprimir .options');
    if (opciones) opciones.disabled = valor;
  }

  function setStatusComprimir(mensaje, tipo = 'normal') {
    asignarTextoSeguro(statusComprimir, mensaje, 260);
    statusComprimir.classList.toggle('is-error', tipo === 'error');
    statusComprimir.classList.toggle('is-loading', tipo === 'loading');
  }

  function errorUsuario(mensaje) {
    const err = new LimiteError(mensaje);
    return err;
  }

  function renderArchivoComprimir() {
    listComprimir.replaceChildren();
    btnComprimir.disabled = !archivoComprimir;
    if (!archivoComprimir) return;

    const nombreSeguro = sanitizarTexto(archivoComprimir.name, 140);
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'file-info';

    const name = document.createElement('span');
    name.className = 'file-name';
    asignarTextoSeguro(name, nombreSeguro, 140);
    name.title = nombreSeguro;

    const size = document.createElement('span');
    size.className = 'file-size';
    asignarTextoSeguro(size, formatBytes(archivoComprimir.size), 30);
    info.append(name, size);

    const controls = document.createElement('div');
    controls.className = 'file-controls';
    const btnRemove = document.createElement('button');
    btnRemove.type = 'button';
    btnRemove.className = 'icon-btn danger';
    btnRemove.textContent = '✕';
    btnRemove.title = 'Quitar archivo';
    btnRemove.setAttribute('aria-label', `Quitar ${nombreSeguro}`);
    btnRemove.addEventListener('click', () => {
      archivoComprimir = null;
      setStatusComprimir('');
      renderArchivoComprimir();
    });
    controls.append(btnRemove);

    li.append(info, controls);
    listComprimir.appendChild(li);
  }

  async function prepararPdfJs() {
    const lib = window.pdfjsLib;
    if (!lib) throw errorUsuario('No se pudo cargar la librería pdf.js. Revisa tu conexión.');
    if (!workerBlobUrl) {
      const resp = await fetch(PDFJS_WORKER_URL);
      if (!resp.ok) throw errorUsuario('No se pudo cargar el motor de compresión. Revisa tu conexión.');
      workerBlobUrl = URL.createObjectURL(new Blob([await resp.text()], { type: 'text/javascript' }));
    }
    lib.GlobalWorkerOptions.workerSrc = workerBlobUrl;
    return lib;
  }

  inputComprimir.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    inputComprimir.value = '';
    if (!file) return;

    setStatusComprimir('Verificando archivo...', 'loading');
    btnComprimir.disabled = true;
    const validacion = await validarArchivoPDFEstricto(file);
    if (!validacion.valido) {
      archivoComprimir = null;
      renderArchivoComprimir();
      setStatusComprimir(validacion.motivo, 'error');
      return;
    }

    archivoComprimir = file;
    renderArchivoComprimir();
    setStatusComprimir('Listo para comprimir.');
  });

  btnComprimir.addEventListener('click', async () => {
    const archivo = archivoComprimir;
    if (!archivo) return;

    if (!PDFDocument) {
      setStatusComprimir('No se pudo cargar la librería pdf-lib. Revisa tu conexión.', 'error');
      return;
    }

    const nivel = document.querySelector('input[name="nivel"]:checked')?.value;
    const { escala, calidad } = NIVELES_COMPRESION[nivel] || NIVELES_COMPRESION.media;
    const nombreBase = sanitizarNombreArchivo(archivo.name, 'documento');

    setButtonLoading(btnComprimir, true, 'Comprimiendo...', 'Comprimir archivo');
    bloquearComprimir(true);
    setStatusComprimir('Preparando compresión...', 'loading');
    await esperarRenderizado();

    let pdfjsDoc = null;
    const canvas = document.createElement('canvas');

    try {
      const lib = await prepararPdfJs();
      const datos = new Uint8Array(await archivo.arrayBuffer());
      pdfjsDoc = await lib.getDocument({ data: datos, isEvalSupported: false }).promise;

      const total = pdfjsDoc.numPages;
      if (total > LIMITES_SEGURIDAD.MAX_PAGINAS_COMPRIMIR) {
        throw errorUsuario(
          `El documento tiene ${total} páginas; para comprimir el límite seguro es ${LIMITES_SEGURIDAD.MAX_PAGINAS_COMPRIMIR}.`
        );
      }

      const salida = await PDFDocument.create();
      const ctx = canvas.getContext('2d');

      for (let i = 1; i <= total; i++) {
        setStatusComprimir(`Comprimiendo página ${i} de ${total}...`, 'loading');
        await esperarRenderizado();

        const pagina = await pdfjsDoc.getPage(i);
        const base = pagina.getViewport({ scale: 1 });
        const escalaEf = Math.min(
          escala,
          Math.sqrt(LIMITES_SEGURIDAD.MAX_PIXELES_CANVAS / (base.width * base.height))
        );
        const vista = pagina.getViewport({ scale: escalaEf });

        canvas.width = Math.ceil(vista.width);
        canvas.height = Math.ceil(vista.height);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await pagina.render({ canvasContext: ctx, viewport: vista }).promise;

        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', calidad));
        if (!blob) throw new Error('No se pudo generar la imagen de la página.');

        const imagen = await salida.embedJpg(await blob.arrayBuffer());
        const nueva = salida.addPage([base.width, base.height]);
        nueva.drawImage(imagen, { x: 0, y: 0, width: base.width, height: base.height });
        pagina.cleanup();
      }

      setStatusComprimir('Generando archivo final...', 'loading');
      await esperarRenderizado();
      const pdfBytes = await guardarPDFOptimizado(salida);

      if (pdfBytes.byteLength >= archivo.size) {
        setStatusComprimir(
          nivel === 'alta'
            ? 'No se descargó nada: el resultado no sería más pequeño que el original. Este PDF ya está optimizado.'
            : 'No se descargó nada: el resultado no sería más pequeño que el original. Prueba con el nivel Alta.',
          'error'
        );
        return;
      }

      descargarPDF(pdfBytes, `${nombreBase}-comprimido.pdf`);
      const ahorro = Math.round((1 - pdfBytes.byteLength / archivo.size) * 100);
      setStatusComprimir(
        `¡Listo! ${formatBytes(archivo.size)} → ${formatBytes(pdfBytes.byteLength)} (−${ahorro}%).`
      );
    } catch (error) {
      console.error('Error al comprimir PDF:', error);
      setStatusComprimir(
        error.mostrar
          ? error.message
          : 'No se pudo comprimir el PDF (puede estar dañado o protegido con contraseña).',
        'error'
      );
    } finally {
      canvas.width = 0;
      canvas.height = 0;
      if (pdfjsDoc) pdfjsDoc.destroy();
      bloquearComprimir(false);
      setButtonLoading(btnComprimir, false, '', 'Comprimir archivo');
      btnComprimir.disabled = !archivoComprimir;
    }
  });

  // ==========================================================
  // Extras de interfaz
  // ==========================================================
  inputRango.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !btnDividir.disabled) {
      e.preventDefault();
      btnDividir.click();
    }
  });

  document.querySelectorAll('.dropzone').forEach((zona) => {
    const activar = (e) => { e.preventDefault(); zona.classList.add('is-dragover'); };
    const desactivar = (e) => {
      if (e.type === 'dragleave' && zona.contains(e.relatedTarget)) return;
      zona.classList.remove('is-dragover');
    };
    zona.addEventListener('dragenter', activar);
    zona.addEventListener('dragover', activar);
    zona.addEventListener('dragleave', desactivar);
    zona.addEventListener('drop', desactivar);
  });
})();
