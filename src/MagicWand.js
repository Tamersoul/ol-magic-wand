/**
 * @module ol/interaction/MagicWand
 */

import BaseObject from 'ol/Object';
import { Pointer as PointerInteraction } from 'ol/interaction';
import { unByKey } from 'ol/Observable'

import MagicWandLib from 'magic-wand-tool';

/**
 * @typedef {Object} Point
 * @property {number} x
 * @property {number} y
 */

/**
 * @typedef {Object} Size
 * @property {number} w
 * @property {number} h
 */

/**
 * @typedef {Object} Bounds
 * @property {number} minX
 * @property {number} maxX
 * @property {number} minY
 * @property {number} maxY
 */

/**
 * @typedef {Object} Mask
 * @property {Uint8Array} data
 * @property {number} width
 * @property {number} height
 * @property {number} [bytes]
 * @property {Bounds} [bounds]
 * @property {Point} globalOffset
 */

/**
 * @typedef {Object} Contour
 * @property {Array<Point>} points Vertices of the polygon (closed figure)
 * @property {boolean} inner Indicates whether the polygon is inside another
 * @property {number} label Contour id
 * @property {number} [initialCount] Length of the point array before simplifying
 */

/**
 * @typedef {Object} OffsetMask
 * @property {Uint8Array} data 1-D binary data array
 * @property {Size} size Mask size
 * @property {Point} offset Coordinates of the top-left corner in viewport basis
 */

/**
 * @typedef {Object} PixelOffset
 * @property {number} x Left coordinate
 * @property {number} y Top coordinate
 * @property {number} width Length of the one world in pixels
 */

/**
 * @typedef {Object} TileMaskOptions
 * @property {ol/Map} map Map
 * @property {ol/layer/Layer|Array<ol/layer/Layer>} layers Layer(s) for scanning
 * @property {number} hatchLength Thickness of the stroke (in pixels)
 * @property {number} hatchTimeout Hatching redraw timeout (in ms)
 */

/**
 * @classdesc
 * Create a snapshot from the specified layers and show the current selection mask
 *
 * @fires ol/events/Event#scanStarted
 * @fires ol/events/Event#scanFinished
 */
export class TileMask extends BaseObject {

    /**
     * @param {TileMaskOptions} options Tile mask options
     */
    constructor(options) {
        super();

        /**
         * @type {ol/Map}
         */
        this.map = options.map;

        /**
         * Layers for scanning 
         * @type {Array<ol/layer/Layer>}
         */
        this.layers = null;

        /**
         * Binary mask
         * @type {Mask}
         */
        this.mask = null;

        /**
         * Array of indices of a boundary points in the mask
         * @private
         * @type {Array<number>}
         */
        this.border_ = null;

        /**
         * @private
         * @type {number}
         */
        this.hatchInterval_ = null;

        /**
         * @private
         * @type {number}
         */
        this.hatchOffset_ = 0;

        /**
         * @type {number}
         */
        this.hatchLength = options.hatchLength;

        /**
         * @type {number}
         */
        this.hatchTimeout = options.hatchTimeout;

        /**
         * @type {Size}
         */
        this.size = null;

        /**
         * Context for mask
         * @type {CanvasRenderingContext2D}
         */
        this.context = null;

        /**
         * Image data without mask
         * @type {Uint8ClampedArray}
         */
        this.snapshot = null;

        /**
         * @protected
         * @type {CanvasRenderingContext2D}
         */
        this.contextWithoutMask = document.createElement("canvas").getContext("2d");

        /**
         * Amount of bytes per pixel in the snapshot
         * @type {number}
         */
        this.bytes = 4;

        /**
         * @private
         * @type {boolean}
         */
        this.loading_ = false;

        /**
         * @private
         * @type {boolean}
         */
        this.lock_ = false;

        /**
         * @private
         * @type {ol/events/Array<EventsKey>}
         */
        this.mapKeys_ = null;

        /**
         * @private
         * @type {ol/events/Array<EventsKey>}
         */
        this.layersKeys_ = null;

        /**
         * @private
         * @type {ol/events/EventsKey}
         */
        this.mapKeyOnceComplete = null;

        /**
         * @private
         * @type {ol/events/EventsKey}
         */
        this.mapKeyOnceRender = null;

        this.createCanvas();

        this.connectToMap();

        this.setLayers(options.layers);

        if (this.hatchTimeout && this.hatchTimeout > 0) {
            this.hatchInterval = setInterval(() => this.hatchTick_(), this.hatchTimeout);
        }
    }

    /**
     * Creates a tile canvas.
     * @protected
     */
    createCanvas() {
        this.context = document.createElement("canvas").getContext("2d");
        this.setCanvasSize();
        this.clearMask();
    }

    /**
     * @protected
     */
    setCanvasSize() {
        let size = this.map.getSize();

        this.context.canvas.width = size[0];
        this.context.canvas.height = size[1];

        this.contextWithoutMask.canvas.width = size[0];
        this.contextWithoutMask.canvas.height = size[1];

        this.size = { w: size[0], h: size[1] };
    }

    /**
     * @inheritDoc
     */
    disposeInternal() {
        this.disconnectFromMap();
        this.disconnectFromLayers();
        this.clearMask();

        // stop hatching animation
        if (this.hatchInterval) clearInterval(this.hatchInterval);

        this.layers = null;
        this.contextWithoutMask = null;
        this.context = null;
        this.snapshot = null;
        this.map = null;

        super.disposeInternal();
    }

    //#region Map

    /**
     * @protected
     */
    connectToMap() {
        this.mapKeys_ = [
            this.map.getView().on('change:resolution', this.onViewResChanged_.bind(this)),
            this.map.on('change:size', this.onMapSizeChanged_.bind(this)),
            this.map.on('moveend', this.onMapMoved_.bind(this)),
            this.map.on('postrender', this.onPostRender_.bind(this))
        ];
    }

    /**
     * @protected
     */
    disconnectFromMap() {
        if (this.mapKeys_) {
            unByKey(this.mapKeys_);
            this.mapKeys_ = null;
        }
        if (this.mapKeyOnceComplete) {
            unByKey(this.mapKeyOnceComplete);
            this.mapKeyOnceComplete = null;
        }
        if (this.mapKeyOnceRender) {
            unByKey(this.mapKeyOnceRender);
            this.mapKeyOnceRender = null;
        }
    }

    /**
     * @private
     */
    onViewResChanged_() {
        this.createCanvas();
        this.setCanvasSize();
    }

    /**
     * @private
     */
    onMapSizeChanged_() {
        this.setCanvasSize();
        setTimeout(() => this.scan(), 50);
    }

    /**
     * @private
     */
    onMapMoved_() {
        this.scan();
    }

    //#endregion

    //#region Layers

    /**
     * @param {ol/layer/Layer | Array<ol/layer/Layer>} layers Layer(s) for scanning
     * @return {boolean}
     */
    setLayers(layers) {
        if (!layers) return false;

        this.disconnectFromLayers();

        this.layers = Array.isArray(layers) ? layers : [layers];

        this.connectToLayers();

        this.scan();

        return true;
    }

    /**
     * @protected
     */
    connectToLayers() {
        this.layersKeys_ = [];
        this.layers.forEach((layer) => {
            this.layersKeys_.push(
                layer.on('change', (e) => this.scan()),
                layer.on('propertychange', (e) => this.scan())
                //layer.getSource().on('change', (e) => this.scan()),
                //layer.getSource().on('propertychange', (e) => this.scan())
            );
        });
    }

    /**
     * @protected
     */
    disconnectFromLayers() {
        if (this.layersKeys_) {
            unByKey(this.layersKeys_);
            this.layersKeys_ = null;
        }
    }

    //#endregion

    //#region Snapshot

    /**
     * Indicates whether or not the snapshot is fully loaded
     */
    isReady() {
        return !this.loading_ && this.snapshot != null;
    }

    /**
     * Force to recreate the snapshot
     */
    scan() {
        if (this.loading_ || !this.map) return;

        this.snapshot = null;

        if (!this.hasVisibleLayers_()) return;

        this.dispatchEvent("scanStarted");

        let sz = this.map.getSize();
        this.size = { w: sz[0], h: sz[1] };

        this.loading_ = true;

        this.mapKeyOnceComplete = this.map.once('rendercomplete', () => {
            if (!this.lock_) {
                this.mapKeyOnceRender = this.map.once('postrender', () => {

                    if (this.getRenderLayers_().length > 0) {
                        this.snapshot = this.contextWithoutMask.getImageData(0, 0, this.size.w, this.size.h).data;
                    }

                    this.loading_ = false;
                    this.lock_ = false;

                    this.dispatchEvent("scanFinished");
                });
            }
            this.lock_ = true;
            this.map.render(); // force to call postrender
        });
        this.map.render(); // force to call rendercomplete
    }

    hasVisibleLayers_() {
        return this.layers != null && this.layers.filter(l => {
            return l.getVisible() && l.getOpacity() > 0;
        }).length > 0;
    }

    /**
     * @private
     * @param {RenderEvent} e
     */
    onPostRender_() {
        if (this.lock_) {
            this.contextWithoutMask.clearRect(0, 0, this.size.w, this.size.h);
            this.getRenderLayers_().forEach((layer) => {
                let cnv = layer.getRenderer().context.canvas;
                this.contextWithoutMask.drawImage(cnv, 0, 0, cnv.width, cnv.height, 0, 0, this.size.w, this.size.h);
            });
        }
        this.drawBorder();
    }

    //#endregion

    //#region Mask

    /**
     * Render the current context to the top visible layer
     * @param {boolean} [clear=false] Render the snapshot before
     */
    render(clear = false) {
        let layers = this.getRenderLayers_();
        if (layers.length == 0) return;

        let layerCtx = layers[layers.length - 1].getRenderer().context; // top layer

        // render snapshot context without mask
        if (clear) {
            let snap = this.contextWithoutMask;
            layerCtx.drawImage(snap.canvas, 0, 0, snap.canvas.width, snap.canvas.height, 0, 0, layerCtx.canvas.width, layerCtx.canvas.height);
        }

        let ctx = this.context;
        layerCtx.drawImage(ctx.canvas, 0, 0, ctx.canvas.width, ctx.canvas.height, 0, 0, layerCtx.canvas.width, layerCtx.canvas.height);
    }

    /**
     * @private
     * @return {Array<ol/layer/Layer>} renderable layers
     */
    getRenderLayers_() {
        return this.layers == null ? [] : this.layers.filter(l => {
            let ctx = l.getRenderer().context;
            return ctx && l.getVisible() && l.getOpacity() > 0 && ctx.canvas.width > 0 && ctx.canvas.height > 0;
        }).sort((a, b) => a.getZIndex() - b.getZIndex());
    }

    /**
     * @private
     */
    hatchTick_() {
        this.hatchOffset_ = (this.hatchOffset_ + 1) % (this.hatchLength * 2);
        return this.drawBorder(false);
    }

    /**
     *  Clear the current mask and remove it from the map
     */
    clearMask() {
        this.mask = null;
        this.border_ = null;
        if (this.context)
            this.context.clearRect(0, 0, this.size.w, this.size.h);

        this.map.render();
    }

    /**
     * Set a binary mask and render it
     * @param {Mask} mask
     */
    setMask(mask) {
        this.mask = mask;
        this.map.render();
    }

    /**
     * Draw a hatch border of the binary mask
     * @param {boolean} [needBorder = true] If true, needs to recreate a border
     */
    drawBorder(needBorder = true) {
        if (!this.mask) return false;

        var i, j, k, q, len,
            w = this.size.w, // viewport size
            h = this.size.h,
            ix = this.size.w - 1, // right bottom of viewport (left top = [0,0])
            iy = this.size.h - 1,
            sw = this.size.w + 2, // extend viewport size (+1 px on each side)
            sh = this.size.h + 2;

        if (needBorder) { // create border

            var offset = MagicWand.getMainWorldOffset(this.map); // viewport offset in the main world basis

            var dx, dy, x0, y0, x1, y1, k1, k2,
                rx0, rx1, ry0, ry1, // result of the intersection mask with the viewport (+1 px on each side)
                img = this.mask.data,
                w1 = this.mask.width,
                b = this.mask.bounds,
                gf = this.mask.globalOffset, // mask offset in the main world basis,
                data = new Uint8Array(sw * sh), // viewport data (+1 px on each side) for correct detection border
                off,
                maskOffsets = [{ // all posible mask world offsets (considering 'multiWorld')
                    x: gf.x,
                    y: gf.y
                }, { // add the mask in the left world
                    x: (gf.x - offset.width) + 1,  // 1px for overlap
                    y: gf.y
                }, { // add the mask in the right world
                    x: (gf.x + offset.width) - 1,  // 1px for overlap
                    y: gf.y
                }];

            // walk through all worlds
            var offsetsLen = maskOffsets.length;
            for (j = 0; j < offsetsLen; j++) {
                off = maskOffsets[j]; // viewport offset in the world basis
                dx = off.x - offset.x; // delta for the transformation to the viewport basis (mask offset in the viewport basis)
                dy = off.y - offset.y;
                x0 = dx + b.minX; // left top of binary image (in viewport basis)
                y0 = dy + b.minY;
                x1 = dx + b.maxX; // right bottom of binary image (in viewport basis)
                y1 = dy + b.maxY;

                // intersection of the mask with viewport
                if (!(x1 < 0 || x0 > ix || y1 < 0 || y0 > iy)) {
                    rx0 = x0 > -1 ? x0 : -1; // intersection +1 px on each side (for search border)
                    ry0 = y0 > -1 ? y0 : -1;
                    rx1 = x1 < ix + 1 ? x1 : ix + 1;
                    ry1 = y1 < iy + 1 ? y1 : iy + 1;
                } else {
                    continue;
                }
                // copy result of the intersection(+1 px on each side) to image data for detection border
                len = rx1 - rx0 + 1;
                i = (ry0 + 1) * sw + (rx0 + 1);
                k1 = (ry0 - dy) * w1 + (rx0 - dx);
                k2 = (ry1 - dy) * w1 + (rx0 - dx) + 1;
                // walk through rows (Y)
                for (k = k1; k < k2; k += w1) {
                    // walk through cols (X)
                    for (q = 0; q < len; q++) {
                        if (img[k + q] === 1) data[i + q] = 1; // copy only "black" points
                    }
                    i += sw;
                }
            }

            // save result of border detection for animation
            this.border_ = MagicWandLib.getBorderIndices({ data: data, width: sw, height: sh });
        }

        this.context.clearRect(0, 0, w, h);

        var ind = this.border_; // array of indices of the boundary points
        if (!ind) return false;

        var x, y,
            imgData = this.context.createImageData(w, h), // result image
            res = imgData.data,
            hatchLength = this.hatchLength,
            hatchLength2 = hatchLength * 2,
            hatchOffset = this.hatchOffset_;

        len = ind.length;

        for (j = 0; j < len; j++) {
            i = ind[j];
            x = i % sw; // calc x by index
            y = (i - x) / sw; // calc y by index
            x -= 1; // viewport coordinates transformed from extend (+1 px) viewport
            y -= 1;
            if (x < 0 || x > ix || y < 0 || y > iy) continue;
            k = (y * w + x) * 4; // result image index by viewport coordinates
            if ((x + y + hatchOffset) % hatchLength2 < hatchLength) { // detect hatch color 
                res[k + 3] = 255; // black, set only alpha
            } else {
                res[k] = 255; // white
                res[k + 1] = 255;
                res[k + 2] = 255;
                res[k + 3] = 255;
            }
        }

        this.context.putImageData(imgData, 0, 0);

        this.render();

        return true;
    }

    //#endregion

    /**
     * Get color of the snapshot by screen coordinates
     * @param {number} x
     * @param {number} y
     * @return {Array<number>} RGBA color
     */
    getPixelColor(x, y) {
        var i = (y * this.size.w + x) * this.bytes;
        var res = [this.snapshot[i], this.snapshot[i + 1], this.snapshot[i + 2], this.snapshot[i + 3]];
        return res;
    }

    /**
     * Create data URL from the snapshot
     * @param {string} [format="image/png"] Image type
     * @return {string} Image binary content URL
     */
    toImageUrl(format = "image/png") {
        if (!this.isReady() || !this.size) return null;

        var canvas = document.createElement("canvas");
        var context = canvas.getContext("2d");
        context.canvas.width = this.size.w;
        context.canvas.height = this.size.h;

        var imgData = context.createImageData(this.size.w, this.size.h);
        for (var i = 0; i < this.snapshot.length; i++) {
            imgData.data[i] = this.snapshot[i];
        }
        context.putImageData(imgData, 0, 0);

        return canvas.toDataURL(format);
    }

}

/**
 * @typedef {Object} MagicWandOptions
 * @property {ol/layer/Layer|Array<ol/layer/Layer>} layers Layer(s) for scanning
 * @property {string} [waitClass] CSS class for map when snapshot is loading
 * @property {string} [drawClass] CSS class for map when "add mode" is turned off (default)
 * @property {string} [addClass] CSS class for map when "add mode" is turned on
 * @property {number} [hatchLength=4] Thickness of the stroke (in pixels)
 * @property {number} [hatchTimeout=300] Hatching redraw timeout (in ms)
 * @property {number} [colorThreshold=15] Tool parameter: Initial color threshold [1-255] (see method 'floodFill' in 'magic-wand-tool')
 * @property {number} [blurRadius=5] Tool parameter: Blur radius [1-15] (see method 'gaussBlurOnlyBorder' in 'magic-wand-tool')
 * @property {boolean} [includeBorders=true] Tool parameter: Indicate whether to include borders pixels (see method 'floodFill' in 'magic-wand-tool')
 * @property {boolean} [addMode=true] Enable/disable a concatenation of masks ("add mode")
 * @property {boolean} [history=true] Enable/disable mask history functions: undo ('ctrl+z') and redo ('ctrl+y')
 * @property {boolean} [debugMode=false] Enable/disable debug functions: shows contours ('c' key) and current snapshot ('s' key)
*/

/**
 * @classdesc
 * Implementation of the magic-wand tool for the specified layers of the map
 * @api
 */
export default class MagicWand extends PointerInteraction {

    /**
     * @param {MagicWandOptions} options MagicWand options
     */
    constructor(options) {
        super();

        /**
         * Layer(s) for scanning
         * @protected
         * @type {ol/layer/Layer|Array<ol/layer/Layer>}
         */
        this.layers = options.layers;

        /**
         * @type {number}
         */
        this.hatchLength = options.hatchLength == null ? 4 : options.hatchLength;

        /**
         * @type {number}
         */
        this.hatchTimeout = options.hatchTimeout == null ? 300 : options.hatchTimeout;

        /**
         * @type {number}
         */
        this.colorThreshold = options.colorThreshold == null ? 15 : options.colorThreshold;

        /**
         * @type {number}
         */
        this.blurRadius = options.blurRadius == null ? 5 : options.blurRadius;

        /**
         * @type {boolean}
         */
        this.includeBorders = options.includeBorders == null ? true : options.includeBorders;

        /**
         * @private
         * @type {number}
         */
        this.currentThreshold_ = 0;

        /**
         * History of binary masks
         * @type {MaskHistory}
         */
        this.history = options.history == false ? null : new MaskHistory();

        /**
         * Tile for displaying mask
         * @private
         * @type {TileMask}
         */
        this.tileMask_ = null;

        /**
         * @private
         * @type {boolean}
         */
        this.isMapConnect_ = false;

        /**
         * @private
         * @type {boolean}
         */
        this.allowDraw_ = false;

        /**
         * @private
         * @type {boolean}
         */
        this.addMode_ = false;

        /**
         * @private
         * @type {Mask}
         */
        this.oldMask_ = null;

        /**
         * @private
         * @type {Point}
         */
        this.downPoint_ = null;

        /**
         * @private
         * @type {ol/events/Array<EventsKey>}
         */
        this.mapKeys_ = null;

        /**
         * @private
         * @type {boolean}
         */
        this.allowAdd_ = options.addMode == null ? true : options.addMode;

        /**
         * @private
         * @type {boolean}
         */
        this.isDebug_ = options.debugMode == null ? false : options.debugMode;

        if (options.waitClass) this.waitClass = options.waitClass;
        if (options.drawClass) this.drawClass = options.drawClass;
        if (options.addClass) this.addClass = options.addClass;
    }

    //#region Handlers

    /**
     * @inheritDoc
     * @param {ol/MapBrowserPointerEvent} evt
     */
    handleDragEvent(evt) {
        let e = evt.originalEvent;

        // log current pixel color (debug mode)
        //var pixel = this.getMap().getEventPixel(e);
        //if (this.tileMask_ && this.tileMask_.isReady()) {
        //    var r = this.tileMask_.getPixelColor(Math.round(pixel.x), Math.round(pixel.y));
        //    console.log(r[0] + " " + r[1] + " " + r[2] + " " + r[3]);
        //}
        //return;

        if (this.allowDraw_) {
            var pixel = this.getMap().getEventPixel(e);
            var x = Math.round(pixel[0]);
            var y = Math.round(pixel[1]);
            var px = this.downPoint_.x;
            var py = this.downPoint_.y;
            if (x != px || y != py) {
                // color threshold calculation
                var dx = x - px;
                var dy = y - py;
                var len = Math.sqrt(dx * dx + dy * dy);
                var adx = Math.abs(dx);
                var ady = Math.abs(dy);
                var sign = adx > ady ? dx / adx : dy / ady;
                sign = sign < 0 ? sign / 5 : sign / 3;
                var thres = Math.min(Math.max(this.colorThreshold + Math.round(sign * len), 1), 255); // 1st method
                //var thres = Math.min(Math.max(this.colorThreshold + dx / 2, 1), 255); // 2nd method
                //var thres = Math.min(this.colorThreshold + Math.round(len / 3), 255); // 3rd method
                if (thres != this.currentThreshold_) {
                    this.currentThreshold_ = thres;
                    this.drawMask_(px, py);
                }
            }
        }
        return !this.allowDraw_;
    }

    /**
     * @inheritDoc
     * @param {ol/MapBrowserPointerEvent} evt
     */
    handleDownEvent(evt) {
        let e = evt.originalEvent;
        if (e.button == 2) { // right button - draw mask
            if (!this.tileMask_ || !this.tileMask_.isReady() || this.getMap().getView().getAnimating()) return;
            let px = this.getMap().getEventPixel(e);
            this.downPoint_ = { x: Math.round(px[0]), y: Math.round(px[1]) }; // mouse down point (base point)
            this.allowDraw_ = true;
            this.addMode_ = e.ctrlKey; // || e.shiftKey;
            this.drawMask_(this.downPoint_.x, this.downPoint_.y);
        } else { // reset all
            this.allowDraw_ = false;
            this.oldMask_ = null;
            this.addMode_ = false;
            return false;
        }

        return true;
    }

    /**
     * @inheritDoc
     * @param {ol/MapBrowserPointerEvent} evt
     */
    handleUpEvent(evt) {
        let e = evt.originalEvent;

        // add current mask to history
        if (this.allowDraw_ && this.tileMask_ && this.history) {
            this.history.addMask(this.tileMask_.mask);
        }

        // reset all
        this.currentThreshold_ = this.colorThreshold;
        this.allowDraw_ = false;
        this.oldMask_ = null;
        this.addMode_ = false;

        return false;
    }

    /**
     * @private
     */
    onMapKeyDown_(evt) {
        let map = this.getMap();
        if (map) {
            let div = map.getTargetElement();
            if (evt.keyCode == 17 && this.addClass != null && this.allowAdd_) // ctrl press (add mode on)
                div.classList.add(this.addClass);
        }
    }

    /**
     * @private
     */
    onMapKeyUp_(evt) {
        let map = this.getMap();
        if (map) {
            let div = map.getTargetElement();
            let view = map.getView();
            if (evt.keyCode == 17 && this.allowAdd_) div.classList.remove(this.addClass); // ctrl unpress (add mode off)
            if (evt.keyCode == 83 && this.isDebug_) { // 's' key - show current snapshot (debug mode)
                if (!this.tileMask_ || !this.tileMask_.isReady() || view.getInteracting() || view.getAnimating()) return;
                this.tileMask_.context.clearRect(0, 0, this.tileMask_.size.w, this.tileMask_.size.h);
                this.tileMask_.render(true);
            }
            if (evt.keyCode == 67 && this.isDebug_) { // 'c' key - show contours (debug mode)
                if (!this.tileMask_ || !this.tileMask_.isReady() || view.getInteracting() || view.getAnimating()) return;

                var cs = this.getContours();
                if (cs == null) return;

                var outer = cs.filter((c) => !c.inner);
                var inner = cs.filter((c) => c.inner);

                console.log(`Contours: ${outer.length}[${inner.length}]`);

                var ctx = this.tileMask_.context;
                ctx.clearRect(0, 0, this.tileMask_.size.w, this.tileMask_.size.h);

                var i, j, ps;
                // outer
                ctx.beginPath();
                for (i = 0; i < outer.length; i++) {
                    ps = outer[i].points;
                    ctx.moveTo(ps[0].x, ps[0].y);
                    //ctx.arc(ps[0].x, ps[0].y, 2, 0, 2 * Math.PI);
                    for (j = 1; j < ps.length; j++) {
                        ctx.lineTo(ps[j].x, ps[j].y);
                        //ctx.arc(ps[j].x, ps[j].y, 1, 0, 2 * Math.PI);
                    }
                }
                ctx.strokeStyle = "green";
                ctx.stroke();

                // inner
                ctx.beginPath();
                for (i = 0; i < inner.length; i++) {
                    ps = inner[i].points;
                    ctx.moveTo(ps[0].x, ps[0].y);
                    //ctx.arc(ps[0].x, ps[0].y, 2, 0, 2 * Math.PI);
                    for (j = 1; j < ps.length; j++) {
                        ctx.lineTo(ps[j].x, ps[j].y);
                        //ctx.arc(ps[j].x, ps[j].y, 1, 0, 2 * Math.PI);
                    }
                }
                ctx.strokeStyle = "red";
                ctx.stroke();

                this.tileMask_.render(true);
            }
            if (evt.ctrlKey && this.history) { // history manipulations
                var img = null;
                if (evt.keyCode == 89) img = this.history.redo(); // ctrl + y
                if (evt.keyCode == 90) img = this.history.undo(); // ctrl + z
                if (img && this.tileMask_) this.tileMask_.setMask(img); // apply mask from history
            }
        }
    }

    //#endregion

    /**
     * @inheritDoc
     */
    setActive(active) {
        if (!this.getActive() && active) {
            this.onActivate_();
        }
        if (this.getActive() && !active) {
            this.onDeactivate_();
        }
        super.setActive(active);
    }

    /**
     * @private
     */
    onActivate_() {
        let map = this.getMap();
        if (map) {
            this.connectToMap(map);
            this.createMask(map);
        }
    }

    /**
     * @private
     */
    onDeactivate_() {
        this.allowDraw_ = false;
        this.downPoint_ = null;
        this.oldMask_ = null;
        this.addMode_ = false;
        this.disconnectFromMap();
        if (this.tileMask_) this.tileMask_.dispose();
        this.tileMask_ = null;
        this.clearHistory_();
    }

    /**
     * @inheritDoc
     */
    disposeInternal() {
        this.onDeactivate_();

        if (this.history) this.history.dispose();

        this.history = null;
        this.layers = null;

        super.disposeInternal();
    }

    //#region Map

    /**
     * @inheritDoc
     */
    setMap(map) {
        this.onDeactivate_();
        super.setMap(map);
        if (this.getActive()) {
            this.onActivate_();
        }
    }

    /**
     * @protected
     * @param {ol/Map} map
     */
    connectToMap(map) {
        this.mapKeys_ = [
            map.getView().on('change:resolution', this.onViewResChanged_.bind(this))
        ];

        this.keyDownListener = this.onMapKeyDown_.bind(this);
        this.keyUpListener = this.onMapKeyUp_.bind(this);

        document.addEventListener("keydown", this.keyDownListener);
        document.addEventListener("keyup", this.keyUpListener);

        let div = map.getTargetElement();
        if (this.drawClass) div.classList.add(this.drawClass);

        this.onMapContextMenuListener_ = (e) => {
            if (this.getActive()) e.preventDefault();
        };
        div.addEventListener("contextmenu", this.onMapContextMenuListener_);
    }

    /**
     * @protected
     */
    disconnectFromMap() {
        if (this.mapKeys_) {
            unByKey(this.mapKeys_);
            this.mapKeys_ = null;
        }

        document.removeEventListener("keydown", this.keyDownListener);
        document.removeEventListener("keyup", this.keyUpListener);

        let map = this.getMap();
        if (map) {
            let div = map.getTargetElement();
            div.classList.remove(this.drawClass);
            div.classList.remove(this.waitClass);
            div.classList.remove(this.addClass);
            div.removeEventListener("contextmenu", this.onMapContextMenuListener_);
        }
    }

    /**
     * @private
     */
    onViewResChanged_() {
        this.clearHistory_();
    }

    /**
     * @private
     */
    clearHistory_() {
        if (this.history) this.history.clear();
    }

    /**
     * Get pixel offset in the main world
     * @param {ol/Map} map
     * @return {PixelOffset}
    */
    static getMainWorldOffset(map) {
        let extent = map.getView().getProjection().getExtent();
        let topLeft = map.getPixelFromCoordinate([extent[0], extent[3]]);
        topLeft = { x: Math.round(-topLeft[0]), y: Math.round(-topLeft[1]) };
        let bottomRight = map.getPixelFromCoordinate([extent[2], extent[1]]);
        bottomRight = { x: Math.round(-bottomRight[0]), y: Math.round(-bottomRight[1]) };
        let w = topLeft.x - bottomRight.x;
        let x = topLeft.x % w;
        return { x: x < 0 ? x + w : x, y: topLeft.y, width: w };
    }

    //#endregion

    //#region Mask

    /**
     * @protected
     * @param {ol/Map} map
     */
    createMask(map) {
        let div = map.getTargetElement();
        this.tileMask_ = new TileMask({ map: map, layers: this.layers, hatchTimeout: this.hatchTimeout, hatchLength: this.hatchLength });
        if (this.waitClass) {
            this.tileMask_.on("scanStarted", () => div.classList.add(this.waitClass));
            this.tileMask_.on("scanFinished", () => div.classList.remove(this.waitClass));
        }
    }

    /**
     * Concatenate mask and old mask
     * @private
     * @param {Mask} mask
     * @param {Mask} old
     * @return {Mask} concatenated mask
     */
    concatMask_(mask, old) {
        var data1 = old.data,
            data2 = mask.data,
            w1 = old.width,
            w2 = mask.width,
            px1 = old.globalOffset.x,
            py1 = old.globalOffset.y,
            px2 = mask.globalOffset.x,
            py2 = mask.globalOffset.y,
            b1 = old.bounds,
            b2 = mask.bounds,
            px = Math.min(b1.minX + px1, b2.minX + px2), // global offset for new mask (by min in bounds)
            py = Math.min(b1.minY + py1, b2.minY + py2),
            b = { // bounds for new mask include all of the pixels [0,0,width,height] (reduce to bounds)
                minX: 0,
                minY: 0,
                maxX: Math.max(b1.maxX + px1, b2.maxX + px2) - px,
                maxY: Math.max(b1.maxY + py1, b2.maxY + py2) - py
            },
            w = b.maxX + 1, // size for new mask
            h = b.maxY + 1,
            i, j, k, k1, k2, len;

        var result = new Uint8Array(w * h);

        // copy all old mask
        len = b1.maxX - b1.minX + 1;
        i = (py1 - py + b1.minY) * w + (px1 - px + b1.minX);
        k1 = b1.minY * w1 + b1.minX;
        k2 = b1.maxY * w1 + b1.minX + 1;
        // walk through rows (Y)
        for (k = k1; k < k2; k += w1) {
            result.set(data1.subarray(k, k + len), i); // copy row
            i += w;
        }

        // copy new mask (only "black" pixels)
        len = b2.maxX - b2.minX + 1;
        i = (py2 - py + b2.minY) * w + (px2 - px + b2.minX);
        k1 = b2.minY * w2 + b2.minX;
        k2 = b2.maxY * w2 + b2.minX + 1;
        // walk through rows (Y)
        for (k = k1; k < k2; k += w2) {
            // walk through cols (X)
            for (j = 0; j < len; j++) {
                if (data2[k + j] === 1) result[i + j] = 1;
            }
            i += w;
        }

        return {
            data: result,
            width: w,
            height: h,
            bounds: b,
            globalOffset: {
                x: px,
                y: py
            }
        };
    }

    /**
     * Create mask for the specified pixel position
     * @private
     * @param {number} x
     * @param {number} y
     * @return {boolean}
     */
    drawMask_(x, y) {
        if (!this.tileMask_ || !this.tileMask_.isReady()) return false;

        var size = this.tileMask_.size;
        var map = this.getMap();
        var ms = map.getSize();
        var mapSize = { w: ms[0], h: ms[1] };
        if (size.w != mapSize.w || size.h != mapSize.h) { // if map size is not equal to snapshot size then recreate snapshot
            this.tileMask_.scan();
            return false;
            //if (!this.tileMask_.isReady()) return false;
            //size = this.tileMask_.size;
        }

        var tile = this.tileMask_;

        var offset = MagicWand.getMainWorldOffset(map); // snapshot (viewport) offset in the main world

        var image = {
            data: this.tileMask_.snapshot,
            width: size.w,
            height: size.h,
            bytes: this.tileMask_.bytes
        };

        var mask = null;

        if (this.allowAdd_ && this.addMode_ && tile.mask) {
            if (!this.oldMask_) {
                var img = tile.mask;
                var bounds = img.bounds;
                // clone mask
                this.oldMask_ = {
                    data: new Uint8Array(img.data),
                    width: img.width,
                    height: img.height,
                    bounds: {
                        minX: bounds.minX,
                        maxX: bounds.maxX,
                        minY: bounds.minY,
                        maxY: bounds.maxY
                    },
                    globalOffset: {
                        x: img.globalOffset.x,
                        y: img.globalOffset.y
                    }
                };
                var oldOffset = this.oldMask_.globalOffset,
                    offsets = [{ x: oldOffset.x, y: oldOffset.y }]; // add old mask offset (current world)

                let i, j, k, k1, k2, len, off,
                    x0, y0, x1, y1, dx, dy,
                    rx0, rx1, ry0, ry1,
                    w = image.width,
                    h = image.height,
                    data = new Uint8Array(w * h),
                    old = this.oldMask_.data,
                    w1 = this.oldMask_.width,
                    b = this.oldMask_.bounds,
                    ix = image.width - 1, // right bottom of image (left top = [0,0])
                    iy = image.height - 1,
                    offsetsLen = offsets.length;

                // copy visible data from old mask for floodfill (considering 'multiWorld' and neighboring worlds)
                for (j = 0; j < offsetsLen; j++) {
                    off = offsets[j]; // old mask offset in the global basis
                    dx = off.x - offset.x; // delta for the transformation to image basis
                    dy = off.y - offset.y;
                    x0 = dx + b.minX; // left top of old mask (in image basis)
                    y0 = dy + b.minY;
                    x1 = dx + b.maxX; // right bottom of old mask (in image basis)
                    y1 = dy + b.maxY;

                    // intersection of the old mask with the image (viewport)
                    if (!(x1 < 0 || x0 > ix || y1 < 0 || y0 > iy)) {
                        rx0 = x0 > 0 ? x0 : 0;  // result of the intersection
                        ry0 = y0 > 0 ? y0 : 0;
                        rx1 = x1 < ix ? x1 : ix;
                        ry1 = y1 < iy ? y1 : iy;
                    } else {
                        continue;
                    }
                    // copy result of the intersection to mask data for floodfill
                    len = rx1 - rx0 + 1;
                    i = ry0 * w + rx0;
                    k1 = (ry0 - dy) * w1 + (rx0 - dx);
                    k2 = (ry1 - dy) * w1 + (rx0 - dx) + 1;
                    // walk through rows (Y)
                    for (k = k1; k < k2; k += w1) {
                        data.set(old.subarray(k, k + len), i); // copy row
                        i += w;
                    }
                }
                this.oldMask_.visibleData = data;
            }

            // create a new mask considering the current visible data
            mask = MagicWandLib.floodFill(image, x, y, this.currentThreshold_, this.oldMask_.visibleData, this.includeBorders);
            if (!mask) return false;
            // blur a new mask considering the current visible data
            if (this.blurRadius > 0) mask = MagicWandLib.gaussBlurOnlyBorder(mask, this.blurRadius, this.oldMask_.visibleData);

            mask.globalOffset = offset;

            // check a shortest path for concatenation
            let distance = (offset.x + mask.width / 2) - (this.oldMask_.globalOffset.x + this.oldMask_.width / 2);
            if (Math.abs(distance) > offset.width / 2) {
                mask.globalOffset.x = distance > 0 ? offset.x - offset.width : offset.x + offset.width;
            }
            mask = this.concatMask_(mask, this.oldMask_); // old mask + new mask
        } else {
            mask = MagicWandLib.floodFill(image, x, y, this.currentThreshold_, null, this.includeBorders);
            if (this.blurRadius > 0) mask = MagicWandLib.gaussBlurOnlyBorder(mask, this.blurRadius);
            mask.globalOffset = offset;
        }

        tile.setMask(mask);

        return true;
    }

    //#endregion

    //#region Public

    /**
     * Set map layers to create snapshot and to draw a mask
     * @param {ol/layer/Layer|Array<ol/layer/Layer>} layers Layer(s) for scanning
     * @return {boolean}
     */
    setLayers(layers) {
        if (!layers) return false;

        this.layers = layers;

        return !this.tileMask_ ? false : this.tileMask_.setLayers(layers);
    }

    /**
     * Return contours of binary mask
     * @param {number} [simplifyTolerant=1] Tool parameter: Simplify tolerant (see method 'simplifyContours' in 'magic-wand-tool')
     * @param {number} [simplifyCount=30] Tool parameter: Simplify count (see method 'simplifyContours' in 'magic-wand-tool')
     * @return {Array<Contour>} Contours in the viewport basis
     */
    getContours(simplifyTolerant = 1, simplifyCount = 30) {
        if (!this.tileMask_.mask) return null;

        var offset = MagicWand.getMainWorldOffset(this.getMap()); // viewport offset in the main world

        var i, j, points, len, plen, c,
            mask = this.tileMask_.mask,
            dx = mask.globalOffset.x - Math.round(offset.x),
            dy = mask.globalOffset.y - Math.round(offset.y),
            contours = MagicWandLib.traceContours(mask),
            result = [];

        if (simplifyTolerant > 0) contours = MagicWandLib.simplifyContours(contours, simplifyTolerant, simplifyCount);

        return contours.map(c => {
            c.initialCount = c.initialCount || c.points.length;
            c.points.forEach(p => {
                p.x += dx;
                p.y += dy;
            });
            return c;
        });
    }

    /**
     * Get a data of the current mask
     * @return {OffsetMask} Mask data in the viewport basis
     */
    getMask() {
        if (this.tileMask_) {
            let mask = this.tileMask_.mask;

            let offset = MagicWand.getMainWorldOffset(this.getMap()); // viewport offset in the main world

            let x, y, k = 0,
                data = mask.data,
                bounds = mask.bounds,
                maskW = mask.width,
                sw = bounds.maxX - bounds.minX + 1,
                sh = bounds.maxY - bounds.minY + 1,
                res = new Uint8Array(sw * sh);

            for (y = bounds.minY; y <= bounds.maxY; y++) {
                for (x = bounds.minX; x <= bounds.maxX; x++) {
                    res[k++] = data[y * maskW + x];
                }
            }

            return {
                data: res,
                size: {
                    w: sw,
                    h: sh
                },
                offset: {
                    x: mask.globalOffset.x + bounds.minX - Math.round(offset.x),
                    y: mask.globalOffset.y + bounds.minY - Math.round(offset.y)
                }
            };
        }
        return null;
    }

    /**
     * Clear the current mask and remove it from the map view
     */
    clearMask() {
        if (this.tileMask_) {
            this.tileMask_.clearMask();
        }
    }

    //#endregion

}


/**
 * @classdesc
 * History of binary masks
 * @api
 */
export class MaskHistory extends BaseObject {

    constructor() {
        super();

        /**
         * Array of masks
         * @type {Array<Mask>}
         */
        this.masks = [];

        /**
         * Current index of history array
         * @type {number}
         */
        this.current = -1;
    }

    /**
     * @inheritDoc
     */
    disposeInternal() {
        this.masks = null;
        super.disposeInternal();
    }

    clear() {
        this.masks.length = 0;
        this.current = -1;
    }

    /**
     * @param {Mask}
     * @return {boolean}
     */
    addMask(mask) {
        if (!mask) return false;

        this.current++;
        this.masks.length = this.current;
        this.masks.push(mask);

        return true;
    }

    /**
     * @return {Mask}
     */
    getCurrent() {
        return this.current > -1 ? this.masks[this.current] : null;
    }

    /**
     * @return {boolean}
     */
    allowUndo() {
        return this.current > 0;
    }

    /**
     * @return {boolean}
     */
    allowRedo() {
        return this.current < this.masks.length - 1;
    }

    /**
     * @return {Mask}
     */
    undo() {
        if (!this.allowUndo()) return null;
        this.current--;
        return this.getCurrent();
    }

    /**
     * @return {Mask}
     */
    redo() {
        if (!this.allowRedo()) return null;
        this.current++;
        return this.getCurrent();
    }

}
