'use strict';

const fs = require('fs');
const tokenDealer = require('token-dealer');
const got = require('got');
const log = require('npmlog');
const untar = require('./util/untar');
const hostedGitInfo = require('../util/hostedGitInfo');
const gotRetries = require('../util/gotRetries');

const logPrefix = 'download/github';

function download(shorthand, ref, tmpDir, options) {
    const url = `https://api.github.com/repos/${shorthand}/tarball/${ref || ''}`;
    const tarballFile = `${tmpDir}/tarball.tar`;

    log.verbose(logPrefix, `Will download tarball of ${shorthand}@${ref || 'default'}..`, { url });

    // Download tarball
    // Use token dealer to circumvent rate limit issues
    return tokenDealer(options.tokens, (token, exhaust) => {
        return new Promise((resolve, reject) => {
            const handleRateLimit = (response, err) => {
                if (response.headers['x-ratelimit-remaining'] === '0') {
                    const isRateLimitError = err && err.statusCode === 403;

                    log.warn(logPrefix, `Token ${token.substr(0, 10)}.. exhausted`);
                    exhaust(Number(response.headers['x-ratelimit-reset']) * 1000, isRateLimitError);
                }
            };

            got.stream(url, {
                timeout: 15000,
                headers: token ? { Authorization: `token ${token}` } : null,
                retries: gotRetries,
            })
            .on('error', (err, details, response) => {
                try {
                    token && response && handleRateLimit(response, err);
                } catch (exhaustedErr) {
                    err = exhaustedErr || err;
                }

                reject(err);
            })
            .on('response', (response) => token && handleRateLimit(response))
            .pipe(fs.createWriteStream(tarballFile))
            .on('error', reject)
            .on('finish', resolve);
        });
    }, {
        group: 'github',
        wait: options.waitRateLimit,
    })
    // Extract tarball
    .then(() => {
        log.verbose(logPrefix, `Successfully downloaded ${shorthand} tarball, will now extract ..`, { tarballFile });
        return untar(tarballFile);
    })
    // Check if the repository does not exist
    //   404 - not found; 400 - invalid repo name, 403 - dmca takedown
    .catch((err) => err.statusCode === 404 || err.statusCode === 400 || err.statusCode === 403, (err) => {
        log.info(logPrefix, `Download of ${shorthand} tarball failed with ${err.statusCode}`, { err });
    })
    .catch((err) => {
        log.error(logPrefix, `Download of ${shorthand} tarball failed`, { err });
        throw err;
    });
}

function github(packageJson, options) {
    const repository = packageJson.repository;

    if (!repository) {
        return null;
    }

    const gitInfo = hostedGitInfo(repository.url);

    if (!gitInfo || gitInfo.type !== 'github') {
        return null;
    }

    return (tmpDir) => {
        const shorthand = `${gitInfo.user}/${gitInfo.project}`;
        const ref = packageJson.gitHead;

        return download(shorthand, ref, tmpDir, options)
        .return();
    };
}

module.exports = github;