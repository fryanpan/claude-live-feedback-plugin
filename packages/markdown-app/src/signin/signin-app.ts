import { mountSignin } from './signin-page.ts';

/** The /signin entry point. The server-rendered shell provides #signin-root;
 *  everything else is `mountSignin`, which the tests drive directly. */
const root = document.getElementById('signin-root');
if (root) mountSignin(root);
