const express = require('express');
const multer = require('multer');
const cors = require('cors');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const fs = require('fs');
const bodyParser = require('body-parser');
const session = require('express-session');
require('express-zip');
const RedisStore = require('connect-redis')(session);
const utils = require('./utils');

const mkdir = util.promisify(fs.mkdir);
const readdir = util.promisify(fs.readdir);

const UPLOADS = 'uploads/';

if (!fs.existsSync(UPLOADS)) {
  fs.mkdirSync(UPLOADS);
}

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = `${UPLOADS}${req.session.id}`;
      if (fs.existsSync(dir)) {
        cb(null, dir);
      } else {
        mkdir(dir).then(() => {
          cb(null, dir);
        });
      }
    },
  }),
});

const app = express();
app.use(cors());
app.use(session({
  secret: process.env.SESSION_SECRET,
  store: new RedisStore({
    host: 'redis',
  }),
  resave: false,
  saveUninitialized: true,
}));
app.use((req, res, next) => {
  if (!req.session.next) {
    req.session.next = 65;
    req.session.fileMapping = {};
  }
  next();
});
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOADS));

const zbarSplitRegex = /num='(\d*?)'[\s\S]*?type='(.*?)' quality='(.*?)'.*?\[CDATA\[(.*?)\]\]/g;

async function scanForSplitCodes(file) {
  try {
    const splits = [];
    const { stdout } = await exec(`zbarimg --quiet --xml ${file.path}`);
    let matches;
    // eslint-disable-next-line
    while ((matches = zbarSplitRegex.exec(stdout)) !== null) {
      // This is necessary to avoid infinite loops with zero-width matches
      if (matches.index === zbarSplitRegex.lastIndex) {
        zbarSplitRegex.lastIndex += 1;
      }
      splits[matches[1]] = {
        type: matches[2],
        quality: matches[3],
        name: matches[4],
      };
    }
    return splits;
  } catch (e) {
    return [];
  }
}

async function convert(file, thumbsFolder) {
  const zbarPromise = scanForSplitCodes(file);
  if (!fs.existsSync(thumbsFolder)) {
    await mkdir(thumbsFolder);
  }
  await exec(`convert ${file.path} -resize 300x300\\> ${thumbsFolder}/%03d.png`);
  const files = await readdir(thumbsFolder);
  const split = await zbarPromise;

  return files.map((thumbnailName, i) => (
    {
      src: '', // replaced after
      page: i + 1,
      thumb: `${thumbsFolder}/${thumbnailName}`,
      cutBefore: !!split[i],
      data: split[i] ? split[i] : { name: '' },
      remove: false,
      angle: 0,
    }));
}

app.post('/upload', upload.single('file'), (req, res) => {
  const thumbsFolder = `${UPLOADS}${req.session.id}/${req.file.filename}_thumbs/`;
  convert(req.file, thumbsFolder).then((thumbs) => {
    const char = String.fromCharCode(req.session.next);
    req.session.next += 1;
    req.session.fileMapping[char] = req.file.filename;
    thumbs.forEach((file, i) => {
      // eslint-disable-next-line
      file.src = char;
      if (!file.data.name) {
        // eslint-disable-next-line
        file.data.name = `${char}${i}`;
      }
    });
    res.send(thumbs);
  }).catch((e) => {
    res.status(500).send(e.message);
  });
});

app.post('/export', (req, res) => {
  const commands = utils.pagesToCommands(req.session.fileMapping, req.body);
  Promise.all(commands.map(c => exec(c, { cwd: `${UPLOADS}${req.session.id}/` })))
    .then(() => {
      res.json(commands.map(c => `${UPLOADS}${req.session.id}/${c.split('output ').pop()}`));
    }).catch((e) => {
      res.status(500).json(e);
    });
});

app.post('/zip', (req, res) => {
  let json = req.body;
  if (json.json) {
    json = JSON.parse(json.json);
  }
  res.zip(json.map(f => ({ path: `${UPLOADS}${req.session.id}/${f}`, name: f })),
    'files.zip');
});

app.post('/mafp', (req, res) => {
  let json = req.body;
  if (json.json) {
    json = JSON.parse(json.json);
  }
  const host = req.headers.origin;
  const files = json.map(f => (`${host}/${UPLOADS}${req.session.id}/${f}`));
  try {
    fs.writeFileSync(`${UPLOADS}${req.session.id}/out.json`, JSON.stringify(files));
    res.redirect(`https://bfritscher.github.io/moodle-assignment-feedback-packager/?url=${host}/${UPLOADS}${req.session.id}/out.json`);
  } catch (e) {
    res.sendStatus(500);
  }
});

app.listen(80);
