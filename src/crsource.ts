import { WebClient } from '@slack/web-api';
import fetch from 'node-fetch';

type GrimoireMeta = {
  token: string;
  endpoint: string;
};

async function getGrimoireMetadata(): Promise<GrimoireMeta> {
  const response = await fetch('https://source.chromium.org/');
  const text = await response.text();
  const data = text.split("var GRIMOIRE_CONFIG = '")[1].split(`'`)[0];
  const grimoireConfig = JSON.parse(
    data
      .replace(/\\x([\d\w]{2})/gi, (match, grp) => {
        return String.fromCharCode(parseInt(grp, 16));
      })
      .replace(/\\n/gi, ''),
  );
  const token: string = grimoireConfig[0];
  const endpoint: string = grimoireConfig[6][1];
  return {
    token,
    endpoint,
  };
}

type DeepArrayOfUnknowns = Array<unknown | string | DeepArrayOfUnknowns>;

async function getFileContents(
  grimoire: GrimoireMeta,
  parent: string,
  project: string,
  projectKey: string,
  branch: string,
  fileName: string,
) {
  const response = await fetch(
    `${grimoire.endpoint}/$rpc/devtools.grimoire.FileService/GetContentsStreaming?%24httpHeaders=X-Goog-Api-Key%3A${grimoire.token}%0D%0AX-Goog-Api-Client%3Agrpc-web%2F1.0.0%20grimoire%2F1.0.0%2Buyti2atju1zl.be6of0mawakc.code.codebrowser-frontend-oss-20210330.07_p0%0D%0AX-Server-Timeout%3A60%0D%0AContent-Type%3Aapplication%2Fjson%2Bprotobuf%0D%0AX-User-Agent%3Agrpc-web-javascript%2F0.1%0D%0A`,
    {
      headers: {
        origin: 'https://source.chromium.org',
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body: JSON.stringify([
        [
          [[null, `${project}/${projectKey}`, null, null, parent], null, branch],
          fileName,
          null,
          null,
          null,
          null,
          [],
        ],
        true,
        null,
        true,
        null,
        null,
        null,
        null,
        true,
      ]),
      method: 'POST',
    },
  );
  const data: DeepArrayOfUnknowns = JSON.parse(await response.text());

  const best = { str: '', n: 0 };

  function search(arr: DeepArrayOfUnknowns) {
    for (const item of arr) {
      if (typeof item === 'string') {
        const n = item.split('\n').length;
        if (n > best.n) {
          best.str = item;
          best.n = n;
        }
      } else if (Array.isArray(item)) {
        search(item);
      }
    }
  }

  search(data);
  return best.str;
}

const MAX_SLACK_MSG_LENGTH = 7000;

function maybeTruncate(longContents: string) {
  if (longContents.length <= MAX_SLACK_MSG_LENGTH) return longContents;
  return longContents.slice(0, MAX_SLACK_MSG_LENGTH) + '...';
}

const INDENT_BREAKPOINT = 2;

function indentLength(line: string): number {
  let i = 0;
  while (line[i] === ' ') {
    i++;
  }
  return i;
}

function removeOverIndent(contents: string): string {
  const lines = contents.split('\n');
  if (!lines.length) return contents;

  let minIndent = indentLength(lines[0]);
  for (const line of lines) {
    minIndent = Math.min(minIndent, indentLength(line));
  }

  if (minIndent - INDENT_BREAKPOINT <= 0) return contents;

  return lines.map((l) => l.slice(minIndent)).join('\n');
}

export async function handleChromiumSourceUnfurl(
  url: string,
  message_ts: string,
  channel: string,
  client: WebClient,
) {
  const parsed = new URL(url);
  if (parsed.hostname !== 'source.chromium.org') return false;

  const match = /^https:\/\/source\.chromium\.org\/([a-z0-9]+)\/([a-z0-9]+)\/([a-z0-9]+)\/\+\/([a-z0-9]+):([^;]+)(?:;l=([0-9]+(?:-[0-9]+)?))?/.exec(
    url,
  );
  if (!match) return false;

  const [, parent, project, projectKey, branch, fileName, lineRange] = match;

  const grimoire = await getGrimoireMetadata();
  let contents = await getFileContents(grimoire, parent, project, projectKey, branch, fileName);
  if (lineRange) {
    const start = parseInt(lineRange.split('-')[0], 10);
    if (!isNaN(start)) {
      let end = parseInt(lineRange.split('-')[1], 10);
      if (isNaN(end)) end = start;
      contents = contents
        .split('\n')
        .slice(start - 1, end)
        .join('\n');
      contents = removeOverIndent(contents);
    }
  }

  const unfurl = await client.chat.unfurl({
    channel,
    ts: message_ts,
    unfurls: {
      [url]: {
        color: '#00B8D9',
        fallback: `[${project}/${projectKey}] ${fileName}`,
        title: fileName,
        title_link: url,
        footer_icon: 'https://www.gstatic.com/devopsconsole/images/oss/favicons/oss-96x96.png',
        text: `\`\`\`\n${maybeTruncate(contents)}\n\`\`\``,
        footer: `<https://source.chromium.org/${parent}/${project}/${projectKey}/+/${branch}|${project}/${projectKey}>`,
        mrkdwn_in: ['text'],
      },
    },
  });
  if (unfurl.status !== 200 || !unfurl.ok) {
    console.error('Failed to unfurl', unfurl);
  }

  return true;
}
