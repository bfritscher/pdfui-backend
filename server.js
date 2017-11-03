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
const SSE = require('express-sse');

const mkdir = util.promisify(fs.mkdir);
const readdir = util.promisify(fs.readdir);
const mv = util.promisify(require('mv'));

const simpleParser = require('mailparser').simpleParser;

const sse = new SSE();

const redis = require('redis');

const redisMailSubClient = redis.createClient(6379, 'redis');
const redisMailClient = redis.createClient(6379, 'redis');

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
app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(session({
  secret: process.env.SESSION_SECRET,
  store: new RedisStore({
    host: 'redis',
  }),
  cookie: {
    secure: false,
    httpOnly: false,
  },
  resave: true,
  saveUninitialized: true,
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOADS));

function ensureSession(req) {
  if (!req.session.next) {
    req.session.next = 65;
    req.session.fileMapping = {};
    req.session.pages = [];
  }
}

async function ensureThumbsFolder(thumbsFolder) {
  if (!fs.existsSync(thumbsFolder)) {
    await mkdir(thumbsFolder);
  }
}

const zbarSplitRegex = /num='(\d*?)'[\s\S]*?type='(.*?)' quality='(.*?)'.*?\[CDATA\[(.*?)\]\]/g;

async function scanForSplitCodes(filePath) {
  try {
    const splits = [];
    const { stdout } = await exec(`zbarimg --quiet --xml ${filePath}`);
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

async function saveSplit(split, thumbsFolder) {
  return new Promise((resolve, reject) => {
    redisMailClient.set(thumbsFolder, JSON.stringify(split), (err, resp) => {
      if (err) {
        reject(err);
      } else {
        resolve(resp);
      }
    });
  });
}

async function loadSplit(thumbsFolder) {
  return new Promise((resolve, reject) => {
    redisMailClient.get(thumbsFolder, (err, resp) => {
      if (err || !resp) {
        reject(err);
      } else {
        resolve(JSON.parse(resp));
      }
    });
  });
}

async function convertAndSplit(filePath, thumbsFolder) {
  const zbarPromise = scanForSplitCodes(filePath);
  await ensureThumbsFolder(thumbsFolder);
  await exec(`convert ${filePath} -resize 300x300\\> ${thumbsFolder}/%03d.png`);
  const split = await zbarPromise;
  await saveSplit(split, thumbsFolder);
}

async function addFileToSession(filename, thumbsFolder, req) {
  ensureSession(req);
  const split = await loadSplit(thumbsFolder);
  const files = await readdir(thumbsFolder);
  await ensureThumbsFolder(`${UPLOADS}${req.session.id}`);
  const sessionThumbsFolder = `${UPLOADS}${req.session.id}/${filename}_thumbs/`;
  await ensureThumbsFolder(sessionThumbsFolder);
  if (sessionThumbsFolder !== thumbsFolder) {
    await mv(thumbsFolder, sessionThumbsFolder);
    await mv(thumbsFolder.replace('_thumbs/', ''), sessionThumbsFolder.replace('_thumbs/', ''));
  }

  const char = String.fromCharCode(req.session.next);
  req.session.next += 1;
  req.session.fileMapping[char] = filename;

  const thumbs = files.map((thumbnailName, i) => (
    {
      src: char,
      page: i + 1,
      thumb: `${sessionThumbsFolder}${thumbnailName}`,
      cutBefore: !!split[i],
      data: split[i] ? split[i] : { name: `${char}${i}` },
      remove: false,
      angle: 0,
    }
  ));
  req.session.pages = req.session.pages.concat(thumbs);
  req.session.save();
  return thumbs;
}

function extractAttachments(rawMail) {
  simpleParser(rawMail)
    .then((mail) => {
      mail.attachments.filter(attachment => attachment.contentType === 'application/pdf').forEach((attachment) => {
        const folder = `${UPLOADS}${mail.messageId.replace(/[^\w\s]/gi, '')}`;
        if (!fs.existsSync(folder)) {
          fs.mkdirSync(folder);
        }
        const thumbsFolder = `${folder}/${attachment.filename}_thumbs/`;
        const filePath = `${folder}/${attachment.filename}`;

        fs.writeFileSync(filePath, attachment.content);
        convertAndSplit(filePath, thumbsFolder).then(() => {
          const to = mail.to.value[0].address.split('@')[0];
          const file = {
            thumbsFolder,
            filename: attachment.filename,
            date: mail.date,
          };
          redisMailClient.sadd(to, JSON.stringify(file), () => {
            sse.send(file, to);
          });
        });
      });
    })
    .catch((err) => {
      console.log('Error extracting attachment', err);
    });
}

/* Handle e-mail events */
redisMailSubClient.on('psubscribe', (pattern, count) => {
  console.log('subscribed to ', pattern, count);
});
redisMailSubClient.on('pmessage', (pattern, event, value) => {
  // ENABLE subscription on redis config set notify-keyspace-events Es$
  console.log('pmessage', pattern, event, value);
  redisMailClient.get(value, (err, text) => {
    if (err) {
      console.log('redis error', err);
    }
    const mail = JSON.parse(text);
    console.log('[new mail]', mail.date, mail.to, mail.from, mail.subject);
    extractAttachments(`${mail.raw}${mail.body}`);
  });
});

redisMailSubClient.psubscribe('__keyevent@0__:set');

/* ROUTES */

app.get('/session', (req, res) => {
  const pages = req.session.pages || [];
  res.json(pages);
});

app.get('/reset', (req, res) => {
  req.session.regenerate(() => {
    res.end();
  });
});

app.get('/mail/:to', (req, res) => {
  redisMailClient.smembers(req.params.to, (err, data) => {
    if (err) {
      res.status(500).json(err);
    } else {
      res.json(data.map((s) => {
        const j = JSON.parse(s);
        j.raw = s;
        j.to = req.params.to;
        return j;
      }));
    }
  });
});

app.get('/stream', sse.init);

app.post('/claim', (req, res) => {
  addFileToSession(req.body.filename, req.body.thumbsFolder, req).then((thumbs) => {
    redisMailClient.srem(req.body.to, req.body.raw);
    res.send(thumbs);
  }).catch((e) => {
    redisMailClient.srem(req.body.to, req.body.raw);
    res.status(500).json(e);
  });
});

app.post('/upload', upload.single('file'), (req, res) => {
  const thumbsFolder = `${UPLOADS}${req.session.id}/${req.file.filename}_thumbs/`;
  convertAndSplit(req.file.path, thumbsFolder).then(async () => {
    const thumbs = await addFileToSession(req.file.filename, thumbsFolder, req);
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
