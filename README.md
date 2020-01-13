
[![view on npm](http://img.shields.io/npm/v/ol-magic-wand.svg)](https://www.npmjs.org/package/ol-magic-wand)
[![License: MIT](https://img.shields.io/github/license/tamersoul/ol-magic-wand.svg)](https://github.com/Tamersoul/ol-magic-wand/blob/master/LICENSE.txt)

# Magic Wand (selection tool by color differences) for OpenLayers library

Creates a binary mask and contours (vector data) from the specified layers of the map

## Installation

Install it thought NPM:

```shell
npm install ol-magic-wand
```

## Usage

```js

import "ol/ol.css";

import { Map, View } from "ol";
import { Tile as TileLayer } from "ol/layer";
import { OSM } from "ol/source";
import { defaults as defaultInteractions } from "ol/interaction";
import MagicWand from "ol-magic-wand";

let osm = new TileLayer({
  source: new OSM()
});

let wand = new MagicWand({ 
  layers: osm
});

const map = new Map({
  target: "map",
  interactions: defaultInteractions().extend([wand]),
  layers: [osm],
  view: new View({
    center: [0, 0],
    zoom: 1
  })
});


// set map layer or layers to create snapshot and to draw a mask
wand.setLayers([/* some other layers */]);

// get sequential arrays of points (contours) by the binary mask
let contours = wand.getContours();

// get a data of the current mask: 1-D binary array and top-left corner
let mask = wand.getMask();

// clear the current mask and remove it from the map view
wand.clearMask();

```

### Example usage:

[Live example](https://stackblitz.com/edit/ol-magic-wand)

## License

[MIT](https://opensource.org/licenses/MIT) (c) 2019, Ryasnoy Paul
