import path from 'path';
import packageJson from './package.json';

const banner = `/*
 ${packageJson.description}

 @package ${packageJson.name}
 @author ${packageJson.author}
 @version ${packageJson.version}
 @license ${packageJson.license}
 @copyright (c) 2014-${new Date().getFullYear()}, ${packageJson.author}

*/
`;

export default {
    input: path.resolve(__dirname, './src/MagicWand.js'),
    external: id => /^(magic-wand-tool|ol\/.+)/i.test(id),
    output: [{
        format: 'esm',
        file: path.join(__dirname, `./dist/ol-magic-wand.js`),
        sourcemap: true,
        banner: banner
    }]
};