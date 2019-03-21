const _ = require('lodash');
const moment = require('moment');
const Promise = require('bluebird');
const rp = require('request-promise');
const nodemailer = require('nodemailer');
const schedule = require('node-schedule');
const config = require('./config');

const commitsUrl = `${config.bbRepoUrl}commits/?page=`;
const diffStatUrl = `${config.bbRepoUrl}diffstat/`;
const diffUrl = `${config.bbRepoUrl}diff/`;

const changedCommits = [];
const changedCommitDiffs = [];

const authObj = {
  user: config.bbUser,
  pass: config.bbPass,
  sendImmediately: true
};

function getWatchedPaths(paths) {
  let found = false;
  let watchedPaths = [];

  _.each(paths, (path) => {
    found = config.watchList.some(interested => path.indexOf(interested) > -1);
    if (found) {
      watchedPaths.push(path);
    }
  });

  return watchedPaths;
}

function getDiffStat(commit) {
  return rp({
    url: diffStatUrl + commit.hash, method: 'GET', auth: authObj, json: true
  })
    .then((res) => {
      const commitPaths = [];
      const diffs = res.values || [];

      _.each(diffs, (diff) => {
        // get path object which could be
        // either old (modified, deleted);
        // or new (added)
        const changed = diff.old || diff.new;
        commitPaths.push(changed.path);
      });

      const watchedPaths = getWatchedPaths(commitPaths);

      if (watchedPaths.length > 0) {
        commit.paths = watchedPaths;
        changedCommits.push(commit);
      }

      return this;
    })
    .catch((err) => {
      console.log('getDiffStat error', err);
      return this;
    });
}

function getDiff(commit) {

  return this;
  var pathQueryString = commit.paths.map(path => 'path=' + path).join('&');
  
  return rp({ url: diffUrl + commit.hash + '?' + pathQueryString, method: 'GET', auth: authObj, json: true })
    .then(function(res) {
      // console.log('Diff:', res);
      commit.diffDetails = res;
      changedCommitDiffs.push(commit);
    })
    .catch(function(err) {
      console.log('getDiff error', err);
    });
}

function buildPathsContent(paths) {
  let rows = '';
  _.each(paths, (path) => {
    rows += `<tr><td>${path}</td></tr>`;
  });

  return `<table>${rows}</table>`;
}

function buildDiffContent(diff) {
  return `<pre>${diff ? diff : ''}</pre>`;
}

function buildCommitContent(commit) {
  const content = `
  <b>Commit:</b> ${commit.hash}<br/>
  <b>Author:</b> ${commit.author}<br/>
  <b>Date:</b> ${commit.date}<br/>
  <b>Message:</b><br/>
  ${commit.message} <br/><br/>
  <b>Changes:</b><br/>
  ${buildPathsContent(commit.paths)}
  <br/>
  ${buildDiffContent(commit.diffDetails)}
  <br/>
  `;

  return content;
}

async function sendEmail(body) {
  // Generate test SMTP service account from ethereal.email
  // Only needed if you don't have a real mail account for testing
  // let account = await nodemailer.createTestAccount();

  // create reusable transporter object using the default SMTP transport
  const transporter = nodemailer.createTransport({
    service: config.emailProvider,
    auth: {
      user: config.emailUser,
      pass: config.emailPass
    }
  });

  // setup email data with unicode symbols
  const mailOptions = {
    from: `"Bitbucket Notifier" <${config.emailFrom}>`, // sender address
    to: config.emailTo, // list of receivers
    subject: `Bitbucket changes for ${config.bbRepoDesc}`, // Subject line
    text: '', // plain text body
    html: body // html body
  };

  // send mail with defined transport object
  const info = await transporter.sendMail(mailOptions);

  console.log('Email sent: %s', info.messageId);
}

function sendNotification(commits) {
  if (commits.length === 0) {
    return;
  }

  let content = '';
  _.each(commits, (changed) => {
    content += buildCommitContent(changed);
    content += '<hr>';
  });

  content += `<h5>Sent by Bitbucket-Repo-Notifier | ${moment().format('LLL')}</h5>`;

  // console.log('email content', content);

  sendEmail(content).catch(console.error);
}

function collectDiffs(commits) {
  if (!commits || commits.length === 0) {
    return;
  }

  const promises = [];
  for (let i = 0; i < commits.length; i++) {
    promises.push(getDiff(commits[i]));
  }

  Promise.all(promises).then(() => {
    // console.log('Collected diffs for commits:', changedCommitDiffs.length);
    
    const coll = changedCommitDiffs.length == 0 ? commits : changedCommitDiffs;
    sendNotification(coll);
  });
}

function checkCommits(commits) {
  if (!commits || commits.length === 0) {
    return;
  }

  const promises = [];
  for (let i = 0; i < commits.length; i++) {
    promises.push(getDiffStat(commits[i]));
  }

  Promise.all(promises).then(() => {
    console.log('Found Commits:', changedCommits.length);
    
    collectDiffs(changedCommits);
  });
}

function filterCommits(data) {
  const comparedDate = config.commitsFilterDate === 'TODAY' ? moment() : moment(config.commitsFilterDate);

  if (!comparedDate.isValid) {
    console.log('env.COMMITS_FILTER_DATE is invalid');
    return [];
  }

  let filtered = _.filter(data, (commit) => {
    if (config.commitsFilterDate === 'TODAY') {
      return moment(commit.date).isSame(comparedDate, 'date');
    }
    return moment(commit.date).isSameOrAfter(comparedDate, 'date');
  });

  const ignoreAuthors = config.ignoreAuthors ? config.ignoreAuthors.split(',') : [];

  if (ignoreAuthors.length > 0) {
    filtered = _.filter(filtered, (commit) => {
      const commitAuthor = commit.author && commit.author.raw ? commit.author.raw.toLowerCase() : '';
      return !ignoreAuthors.some(author => commitAuthor.indexOf(author.toLowerCase()) > -1);
    });
  }

  const ignoreMessages = config.ignoreCommitsWithMessages ? config.ignoreCommitsWithMessages.split(',') : [];

  if (ignoreMessages.length > 0) {
    filtered = _.filter(filtered, (commit) => {
      const commitMessage = commit.message || '';
      return !ignoreMessages.some(msg => ignoreMessages.indexOf(commitMessage) > -1);
    });
  }

  console.log('Filtered Commits:', filtered.length);

  if (filtered.length === 0) {
    return [];
  }

  const arr = _.map(filtered, (commit) => {
    const obj = {
      hash: commit.hash,
      message: commit.message,
      author: commit.author ? commit.author.raw : '',
      date: moment(commit.date).format('LLL')
    };
    return obj;
  });

  // console.log('commits', arr);

  return arr;
}

function buildExcludeQueryString() {
  const ignoreCommits = config.ignoreCommits ? config.ignoreCommits.split(',') : [];
  const excludeQueryParams = ignoreCommits.map(name => 'exclude=' + name).join('&');
  return excludeQueryParams ? '&' + excludeQueryParams : '';
}

function checkRepo() {
  const requests = [];
  
  // Make a number of paged requests which would return 30 commits per page
  for (let i = 1; i <= config.commitPages; i++) {
    requests.push(rp({
      url: `${commitsUrl}${i}${buildExcludeQueryString()}`, method: 'GET', auth: authObj, json: true
    }));
  }

  Promise.all(requests)
    .then((res) => {
      const commits = [];

      for (let i = 0; i < res.length; i++) {
        commits.push(...res[i].values);
      }

      console.log('Retrieved Commits:', commits.length);
      const mapped = filterCommits(commits);
      checkCommits(mapped);
    })
    .catch((err) => {
      console.log('Get commits failed', err);
    });
}

function parseScheduleDate(val) {
  if (!val) {
    console.log('parseScheduleDate value is empty');
    return null;
  }

  const dateObj = {};
  const parts = val.split(',') || [];
  _.each(parts, (part) => {
    const prop = part.split(':');
    dateObj[prop[0]] = Number(prop[1]);
  });
  return dateObj;
}

/**
 * Start app
 */

// Check the command arguments for "-now"
// to bypass the scheduler
let isRunNow = false;
process.argv.forEach((val, index) => {
  // console.log('arg', index, val);
  if (index === 2 && val === '-now') {
    isRunNow = true;
  }
});

console.log('Watch list', config.watchList);

if (isRunNow) {
  console.log('Bypass scheduler');
  checkRepo();

} else {
  const scheduleDate = parseScheduleDate(config.scheduleDate);

  if (_.isEmpty(scheduleDate)) {
    throw new Error('Scheduler Date is Emtpy.');
  }

  console.log(`Scheduled for ${config.scheduleDate}`);

  schedule.scheduleJob(scheduleDate, () => {
    checkRepo();
  });
}

