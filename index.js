#!/usr/bin/env node

const childProcess = require('child_process');
const request = require('request');
const path = require('path');
const rimraf = require('rimraf');
const fs = require('fs');
const showdown  = require('showdown');

const staticDirectory = path.join(__dirname, 'static');
const lockFile = readLockFile();
const converter = new showdown.Converter();

let outputDirectory = './reports/outdated-changelogs';
let changelogs = [];

main();


// main
// ===================

async function main() {
  parseParameters();
  setupMarkdoneConverter();
  const dependencies = await getOutdatedDependencies();
  clearOutputDirectory();
  checkNextDependency(dependencies);
}

function parseParameters() {
  const outputParamIndex = process.argv.findIndex((value) => value === '-o')
  if (outputParamIndex !== -1) {
    const outputParamValue = process.argv.slice(outputParamIndex+1, outputParamIndex+2)[0];
    outputDirectory = outputParamValue || outputDirectory;
    console.log(outputDirectory)
  }
}

function setupMarkdoneConverter() {
  converter.setFlavor('github');
}


// npm
// ===================

function readLockFile() {
  logMessage('read lock file');
  let rawdata = fs.readFileSync('package-lock.json');
  return JSON.parse(rawdata);
}

function getOutdatedDependencies () {
  logMessage('get outdated dependencies');
	return new Promise((resolve, reject) => {
		childProcess.exec('npm outdated --json --long', (error, stdout) => {
			if (error && stdout.length === 0) {
				reject(error);
      }
      
      else {
        let response = JSON.parse(stdout || '{}')
        resolve(response);
      }
		});
	});
}

function getRegistryInfos(homepageUrl, dependencyName, currentVersion, targetVersion) {
  logInfo(`get infos for ${dependencyName}`);

	return new Promise((resolve, reject) => {
    let registryUrl = getRegistryUrl(dependencyName);
    request(registryUrl, {json: true}, (err, res, json) => {
      if (res && res.statusCode < 300 && json && json['repository'] && json['repository']['url']) {
        resolve({
          repoUrl: `https://${json['repository']['url'].match('.*(github\.com.*)\.git')[1]}`,
          currentVersionDate: json['time'][currentVersion],
          targetVersionDate: json['time'][targetVersion],
        });
      }
      else {
        reject(`Repository not found for ${homepageUrl}`);
      }
    });
  });
}


// retrieve data
// ===================

function checkNextDependency(dependencies) {
  let allKeys = Object.keys(dependencies);

  if (allKeys.length === 0) {
    writeFiles();
    return;
  }

  let key = allKeys[0];
  let currentVersion = dependencies[key]['current'];
  let targetVersion = dependencies[key]['latest'];
  let homepageUrl = dependencies[key]['homepage'];
  let registryInfos;

  console.log(``);
  logMessage(`${key} (${changelogs.length + 1}/${allKeys.length + changelogs.length})`);

  getRegistryInfos(homepageUrl, key, currentVersion, targetVersion)
    .then((infos) => {
      registryInfos = infos;
      return getGithubRawUrl(registryInfos.repoUrl);
    })
    .then((repoRawUrl) => {
      return loadChangelog(registryInfos, repoRawUrl, currentVersion)
    })
    .then((changelog) => {
      let result = formatChangelog(key, changelog, currentVersion, targetVersion, registryInfos.repoUrl);
      changelogs.push(result);
      return sleep(1000);
    })
    .then(() => {
      logSuccess(`✔ ${key} done`);
      delete dependencies[key];
      checkNextDependency(dependencies);
    })
    .catch((error) => {
      logError(`fail for ${key} with ${error}`);
      const result = formatChangelog(`${key}`, 'Changelog not found', currentVersion, targetVersion, registryInfos ? registryInfos.repoUrl : undefined);
      changelogs.push(result);
      delete dependencies[key];
      checkNextDependency(dependencies);
    })
}

async function loadChangelog(registryInfos, githubUrl, version, pos=0) {
  let endpoints = ['CHANGELOG.md', 'RELEASENOTES.md'];
  let url = `${githubUrl}${endpoints[pos]}`;
  logInfo(`get changelog at ${url} (v${version})`);

	return new Promise((resolve, reject) => {
    request(url, {}, (err, res, body) => {
      if (res && res.statusCode < 300) {
        resolve(body);
      }
      else {
        if (pos >= endpoints.length-1) {
          reject(`Changelog not found for ${githubUrl}`);
        } else {
          loadChangelog(registryInfos, githubUrl, version, pos+1).then((content) => {
            resolve(content);
          }).catch((error) => {
            getCommits(registryInfos).then((content) => {
              resolve(content);
            }).catch((error) => {
              reject(error);
            });
          });
        }
      }
    })
  });
}

function getGithubRawUrl(url) {
	return new Promise((resolve, reject) => {
    if(isGithubUrl(url)) {
      let rawUrl = url;
      let anchorPos = url.indexOf('#');
      if (anchorPos !== -1) rawUrl = url.slice(0, anchorPos);
      rawUrl = rawUrl.replace('https://github.com', 'https://raw.githubusercontent.com');
      resolve(`${rawUrl}/master/`);
    } else {
      reject('not a github repo');
    }
  });
}

function isGithubUrl(url) {
  return url.match('https://github.com') !== null;
}

function getRegistryUrl(dependencyName) {
  let url = lockFile['dependencies'][dependencyName]['resolved'] || '';
  let dashPos = url.indexOf('/-/');
  return url.slice(0, dashPos);
}

async function getCommits(registryInfos) {
	return new Promise((resolve, reject) => {
    let repoName = registryInfos.repoUrl.match('.*github\.com\/(.*)')[1];
    logInfo(`get commits for ${repoName}`);

    let url = `https://api.github.com/repos/${repoName}/commits?since=${registryInfos.currentVersionDate}&until=${registryInfos.targetVersionDate}`;
    request(url, { json: true, headers: {'User-Agent': 'odc-1.0.0'} }, (err, res, json) => {
      if (res && res.statusCode < 300 && json) {
        resolve(json.map((res) => `• ${res.commit.committer.date} - ${res.commit.message.replace(/\\n/g, ' | ')}`).join('\n'));
      }
      else {
        reject(`Commit not found for ${repoName}`);
      }
    });
  });
}


// template
// ===================

function executeTemplate(filePath, data = {}) {
  const template = fs.readFileSync(filePath, 'utf8');
  const regex = /{{\s*(.+?)\s*}}/g;

  let output = template;
  while (match = regex.exec(template)) {
    output = output.replace(match[0], eval(`data.${match[1]}`) || "");
  }

  return output;
}

function formatChangelog(dependencyName, content, currentVersion, targetVersion, url) {
  let html = converter.makeHtml(content);
  html = html.replace(/<pre><code/g, '<pre class="code"><code');

  return {
    id: changelogs.length + 1,
    url: url,
    name: dependencyName,
    filename: `${dependencyName}_${currentVersion}-${targetVersion}.html`.replace(/\//g, '-'),
    content: html,
    version: {
      current: currentVersion,
      target: targetVersion,
      type: getUpgradeType(currentVersion, targetVersion),
    },
  }
}

function getUpgradeType(currentVersion = '', targetVersion = '') {
  const currentVersionComponents = currentVersion.split('.');
  const targetVersionComponents = targetVersion.split('.');
  if (currentVersionComponents.length === 3 && targetVersionComponents.length === 3) {
    if (targetVersionComponents[0] > currentVersionComponents[0]) return 'major';
    else if (targetVersionComponents[1] > currentVersionComponents[2]) return 'minor';
    else return 'fix';
  } else {
    return 'unknow';
  }
}

function writeFiles() {
  console.log(``);
  logMessage(`=====================`);

  fs.copyFileSync(`${staticDirectory}/index.css`, `${outputDirectory}/index.css`);

  for (const changelogData of changelogs) {
    logMessage(`write ${changelogData.filename}`);

    let nav = '';
    for (const navData of changelogs) {
      nav += executeTemplate(`${staticDirectory}/nav-template.html`, {
        changelog: navData, 
        selectedClass: navData.name === changelogData.name ? 'selected' : ''
      });
    }

    const html = executeTemplate(`${staticDirectory}/main-template.html`, { 
      nav: nav, changelog: 
      changelogData
    });

    fs.writeFileSync(`${outputDirectory}/${changelogData.filename}`, html);
  }

  console.log("")
  logSuccess(`${changelogs.length} changelog${changelogs.length > 1 ? 's' : ''} available in ${outputDirectory}`);
  logSuccess(`Ready ! 🚀`);
}


// Helpers
// ===================

function logInfo(message) {
  console.log(`\x1b[30m`, `[changelog] ${message}`);
}

function logMessage(message) {
  console.log(`\x1b[36m`, `[changelog] ${message}`);
}

function logSuccess(message) {
  console.log(`\x1b[32m`, `[changelog] ${message}`);
}

function logError(message) {
  console.error(`[changelog] ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clearOutputDirectory() {
  logMessage(`clear output directory ${outputDirectory}`);
	rimraf.sync(outputDirectory);
  fs.mkdirSync(outputDirectory, { recursive: true });
}