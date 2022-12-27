import { Env } from '@humanwhocodes/env';

const env = new Env();
export const environment = {
	repos: env.require('REPOS').split(','),
	workspace: env.get('WORKSPACE', '/tmp'),
	personalAccessToken: env.require('PERSONAL_ACCESS_TOKEN'),
};
