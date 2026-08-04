/**
 * SeeThrough extension frontend.
 * Drives the "See-through" tab: uploads an image, runs the ComfyUI decomposition pipeline over the SeeThroughDecompose
 * websocket API, shows the blended preview and per-layer gallery, and builds a layered PSD in-browser via ag-psd.
 */
class SeeThroughTab {
    constructor() {
        /** Base64 data URL of the currently uploaded input image, or null. */
        this.inputDataUrl = null;
        /** Most recent layer manifest returned by the backend (layers + geometry + inlined PNG data URLs). */
        this.manifest = null;
        /** True while a decomposition request is in flight. */
        this.running = false;
    }

    /** Wires up DOM events and loads the model dropdowns. Called once the session is ready. */
    init() {
        if (this.inited) {
            return;
        }
        this.inited = true;
        getRequiredElementById('seethrough_file').addEventListener('change', (e) => this.onFileChosen(e));
        getRequiredElementById('seethrough_run').addEventListener('click', () => this.run());
        getRequiredElementById('seethrough_dl_psd').addEventListener('click', () => this.downloadPSD('rgba'));
        getRequiredElementById('seethrough_dl_depth_psd').addEventListener('click', () => this.downloadPSD('depth'));
        getRequiredElementById('seethrough_dl_zip').addEventListener('click', () => this.downloadZip());
        this.loadModels();
    }

    /** Loads available LayerDiff and Depth model options into their dropdowns. */
    loadModels() {
        genericRequest('SeeThroughListModels', {}, data => {
            this.fillSelect('seethrough_layer_model', data.layer_models);
            this.fillSelect('seethrough_depth_model', data.depth_models);
        });
    }

    /** Fills a select element with a list of string options. */
    fillSelect(id, options) {
        let select = getRequiredElementById(id);
        select.innerHTML = '';
        if (!options) {
            return;
        }
        for (let opt of options) {
            let el = document.createElement('option');
            el.value = opt;
            el.textContent = opt;
            select.appendChild(el);
        }
    }

    /** Reads the chosen file as a data URL and shows it as the input preview. */
    onFileChosen(e) {
        let file = e.target.files && e.target.files[0];
        if (!file) {
            return;
        }
        let reader = new FileReader();
        reader.onload = () => {
            this.inputDataUrl = reader.result;
            getRequiredElementById('seethrough_input_preview').src = reader.result;
        };
        reader.readAsDataURL(file);
    }

    /** Sets the status line text. */
    setStatus(text) {
        getRequiredElementById('seethrough_status').textContent = text;
    }

    /** Sets the progress bar fill from a 0..1 fraction. */
    setProgress(fraction) {
        let pct = Math.max(0, Math.min(1, fraction)) * 100;
        getRequiredElementById('seethrough_progress_bar').style.width = `${pct}%`;
    }

    /** Highlights the current pipeline stage in the stepper (prior stages marked done). */
    setStage(stage) {
        let order = ['layers', 'depth', 'postprocess', 'finalize'];
        let current = order.indexOf(stage);
        let elements = getRequiredElementById('seethrough_stages').querySelectorAll('.seethrough-stage');
        for (let el of elements) {
            let idx = order.indexOf(el.dataset.stage);
            el.classList.remove('seethrough-stage-active', 'seethrough-stage-done');
            if (current < 0) {
                continue;
            }
            if (idx < current) {
                el.classList.add('seethrough-stage-done');
            }
            else if (idx == current) {
                el.classList.add('seethrough-stage-active');
            }
        }
    }

    /** Collects parameters and starts the decomposition over the websocket API. */
    run() {
        if (this.running) {
            return;
        }
        if (!this.inputDataUrl) {
            this.setStatus('Please choose an image first.');
            return;
        }
        this.running = true;
        this.manifest = null;
        this.setProgress(0);
        this.setStage('layers');
        this.setStatus('Starting...');
        getRequiredElementById('seethrough_run').disabled = true;
        getRequiredElementById('seethrough_downloads').style.display = 'none';
        getRequiredElementById('seethrough_gallery').innerHTML = '';
        let data = {
            'imageData': this.inputDataUrl,
            'layerModel': getRequiredElementById('seethrough_layer_model').value,
            'depthModel': getRequiredElementById('seethrough_depth_model').value,
            'quantMode': getRequiredElementById('seethrough_quant').value,
            'seed': parseInt(getRequiredElementById('seethrough_seed').value) || 0,
            'resolution': parseInt(getRequiredElementById('seethrough_resolution').value) || 1280,
            'steps': parseInt(getRequiredElementById('seethrough_steps').value) || 30,
            'resolutionDepth': parseInt(getRequiredElementById('seethrough_resolution_depth').value),
            'tblrSplit': getRequiredElementById('seethrough_tblr').checked,
            'useLama': getRequiredElementById('seethrough_lama').checked,
            'groupOffload': getRequiredElementById('seethrough_offload').checked,
            'cacheTagEmbeds': getRequiredElementById('seethrough_cache').checked,
            'autoDownload': getRequiredElementById('seethrough_autodl').checked,
            'vaeCkpt': getRequiredElementById('seethrough_vae').value,
            'unetCkpt': getRequiredElementById('seethrough_unet').value
        };
        if (isNaN(data.resolutionDepth)) {
            data.resolutionDepth = -1;
        }
        makeWSRequest('SeeThroughDecompose', data, msg => this.onMessage(msg), 0, err => this.onError(err));
    }

    /** Handles one websocket message from the backend. */
    onMessage(msg) {
        if (msg.status) {
            this.setStatus(msg.status);
        }
        if (msg.stage) {
            this.setStage(msg.stage);
        }
        if (typeof msg.overall_percent != 'undefined') {
            this.setProgress(msg.overall_percent);
        }
        if (msg.preview_image) {
            getRequiredElementById('seethrough_blended_preview').src = msg.preview_image;
        }
        if (msg.layers_info) {
            this.manifest = msg.layers_info;
            this.renderGallery();
        }
        if (msg.success) {
            this.setProgress(1);
            let stages = getRequiredElementById('seethrough_stages').querySelectorAll('.seethrough-stage');
            for (let el of stages) {
                el.classList.remove('seethrough-stage-active');
                el.classList.add('seethrough-stage-done');
            }
            this.setStatus(`Done — ${this.manifest && this.manifest.layers ? this.manifest.layers.length : 0} layers.`);
            getRequiredElementById('seethrough_downloads').style.display = 'block';
            this.finish();
        }
    }

    /** Handles a websocket error. */
    onError(err) {
        this.setStatus(`Error: ${err}`);
        this.finish();
    }

    /** Resets run state and re-enables the button. */
    finish() {
        this.running = false;
        getRequiredElementById('seethrough_run').disabled = false;
    }

    /** Renders the decomposed layers as a labeled thumbnail gallery, ordered back-to-front by depth. */
    renderGallery() {
        let gallery = getRequiredElementById('seethrough_gallery');
        gallery.innerHTML = '';
        if (!this.manifest || !this.manifest.layers) {
            return;
        }
        let layers = this.manifest.layers.slice();
        layers.sort((a, b) => (b.depth_median || 0) - (a.depth_median || 0));
        for (let layer of layers) {
            if (!layer.dataurl) {
                continue;
            }
            let item = createDiv(null, 'seethrough-layer-item');
            let img = document.createElement('img');
            img.className = 'seethrough-layer-img';
            img.src = layer.dataurl;
            item.appendChild(img);
            let label = createDiv(null, 'seethrough-layer-label', escapeHtml(layer.name));
            item.appendChild(label);
            gallery.appendChild(item);
        }
    }

    /** Loads an image element from a URL. */
    loadImage(url) {
        return new Promise((resolve, reject) => {
            let img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`Failed to load layer image`));
            img.src = url;
        });
    }

    /**
     * Builds and downloads a layered PSD from the current manifest.
     * psdType is 'rgba' for the color layers, or 'depth' for the per-layer depth maps.
     */
    async downloadPSD(psdType) {
        if (!this.manifest || !this.manifest.layers) {
            this.setStatus('Nothing to export yet.');
            return;
        }
        if (!window.AgPsd) {
            this.setStatus('PSD library failed to load.');
            return;
        }
        let isDepth = psdType == 'depth';
        let key = isDepth ? 'depth_dataurl' : 'dataurl';
        let width = this.manifest.width;
        let height = this.manifest.height;
        this.setStatus(`Building ${isDepth ? 'depth ' : ''}PSD...`);
        let composite = document.createElement('canvas');
        composite.width = width;
        composite.height = height;
        let compositeCtx = composite.getContext('2d');
        let psdLayers = [];
        for (let layer of this.manifest.layers) {
            let src = layer[key];
            if (!src) {
                continue;
            }
            let img = await this.loadImage(src);
            let lw = layer.right - layer.left;
            let lh = layer.bottom - layer.top;
            if (lw <= 0 || lh <= 0) {
                continue;
            }
            let layerCanvas = document.createElement('canvas');
            layerCanvas.width = lw;
            layerCanvas.height = lh;
            layerCanvas.getContext('2d').drawImage(img, 0, 0, lw, lh);
            compositeCtx.drawImage(img, layer.left, layer.top, lw, lh);
            psdLayers.push({
                name: layer.name,
                canvas: layerCanvas,
                left: layer.left,
                top: layer.top,
                right: layer.right,
                bottom: layer.bottom,
                blendMode: 'normal',
                opacity: 1
            });
        }
        let psd = { width: width, height: height, canvas: composite, children: psdLayers };
        let buffer = window.AgPsd.writePsd(psd);
        let blob = new Blob([buffer], { type: 'application/octet-stream' });
        let url = URL.createObjectURL(blob);
        let a = document.createElement('a');
        let stamp = this.manifest.timestamp || 'output';
        let prefix = this.manifest.prefix || 'seethrough';
        a.href = url;
        a.download = `${prefix}_${stamp}${isDepth ? '_depth' : ''}.psd`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        this.setStatus(`PSD downloaded.`);
    }

    /** Bundles all decomposed layers (color PNGs, depth PNGs when present) and a geometry manifest into a ZIP download. */
    downloadZip() {
        if (!this.manifest || !this.manifest.layers) {
            this.setStatus('Nothing to export yet.');
            return;
        }
        let files = [];
        let used = {};
        /** Ensures a unique name inside the archive. */
        let uniqueName = (base) => {
            let name = base;
            let i = 1;
            while (used[name]) {
                name = base.replace(/\.png$/, '') + '_' + i + '.png';
                i++;
            }
            used[name] = true;
            return name;
        };
        let manifestOut = { width: this.manifest.width, height: this.manifest.height, layers: [] };
        for (let layer of this.manifest.layers) {
            if (layer.dataurl) {
                let fname = uniqueName(`${layer.name}.png`);
                files.push({ name: fname, data: this.dataUrlToBytes(layer.dataurl) });
                manifestOut.layers.push({ name: layer.name, file: fname, left: layer.left, top: layer.top, right: layer.right, bottom: layer.bottom, depth_median: layer.depth_median });
            }
            if (layer.depth_dataurl) {
                let dfname = uniqueName(`${layer.name}_depth.png`);
                files.push({ name: dfname, data: this.dataUrlToBytes(layer.depth_dataurl) });
            }
        }
        if (!files.length) {
            this.setStatus('No layer data to export.');
            return;
        }
        files.push({ name: 'manifest.json', data: this.strToBytes(JSON.stringify(manifestOut, null, 2)) });
        let zipBytes = this.buildZip(files);
        let blob = new Blob([zipBytes], { type: 'application/zip' });
        let url = URL.createObjectURL(blob);
        let a = document.createElement('a');
        let prefix = this.manifest.prefix || 'seethrough';
        let stamp = this.manifest.timestamp || 'output';
        a.href = url;
        a.download = `${prefix}_${stamp}_layers.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        this.setStatus(`ZIP downloaded (${files.length} files).`);
    }

    /** Decodes a base64 data URL into a byte array. */
    dataUrlToBytes(dataUrl) {
        let base64 = dataUrl.split(',')[1] || '';
        let binary = atob(base64);
        let bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    /** Encodes a string into a byte array (UTF-8). */
    strToBytes(str) {
        return new TextEncoder().encode(str);
    }

    /** Concatenates an array of byte arrays into one. */
    concatBytes(arrays) {
        let total = 0;
        for (let arr of arrays) {
            total += arr.length;
        }
        let out = new Uint8Array(total);
        let pos = 0;
        for (let arr of arrays) {
            out.set(arr, pos);
            pos += arr.length;
        }
        return out;
    }

    /** Returns a little-endian 2-byte array. */
    u16(value) {
        return new Uint8Array([value & 0xFF, (value >>> 8) & 0xFF]);
    }

    /** Returns a little-endian 4-byte array. */
    u32(value) {
        return new Uint8Array([value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF]);
    }

    /** Computes (and memoizes) the CRC32 lookup table. */
    crcTable() {
        if (this._crcTable) {
            return this._crcTable;
        }
        let table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[n] = c >>> 0;
        }
        this._crcTable = table;
        return table;
    }

    /** Computes the CRC32 checksum of a byte array. */
    crc32(bytes) {
        let table = this.crcTable();
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) {
            crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    /** Builds an uncompressed (STORE) ZIP archive from a list of {name, data} entries and returns its bytes. */
    buildZip(files) {
        let parts = [];
        let central = [];
        let offset = 0;
        for (let file of files) {
            let crc = this.crc32(file.data);
            let name = this.strToBytes(file.name);
            let size = file.data.length;
            let local = this.concatBytes([
                this.u32(0x04034b50), this.u16(20), this.u16(0), this.u16(0), this.u16(0), this.u16(0),
                this.u32(crc), this.u32(size), this.u32(size), this.u16(name.length), this.u16(0), name
            ]);
            parts.push(local, file.data);
            let cent = this.concatBytes([
                this.u32(0x02014b50), this.u16(20), this.u16(20), this.u16(0), this.u16(0), this.u16(0), this.u16(0),
                this.u32(crc), this.u32(size), this.u32(size), this.u16(name.length), this.u16(0), this.u16(0),
                this.u16(0), this.u16(0), this.u32(0), this.u32(offset), name
            ]);
            central.push(cent);
            offset += local.length + file.data.length;
        }
        let cdStart = offset;
        let cdSize = 0;
        for (let cent of central) {
            parts.push(cent);
            cdSize += cent.length;
        }
        parts.push(this.concatBytes([
            this.u32(0x06054b50), this.u16(0), this.u16(0), this.u16(files.length), this.u16(files.length),
            this.u32(cdSize), this.u32(cdStart), this.u16(0)
        ]));
        return this.concatBytes(parts);
    }
}

let seeThroughTab = new SeeThroughTab();
sessionReadyCallbacks.push(() => seeThroughTab.init());
