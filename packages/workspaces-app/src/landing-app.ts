/**
 * The landing page's only script. `/` is a server-rendered list of
 * workspaces and stays that way; this entry exists solely to define
 * <meeting-banner>, which the shell renders above the list. Its own bundle
 * rather than a share of board.js because the landing page must stay a few KB
 * — the banner is self-styling (shadow DOM) and needs none of the app CSS.
 */
import './meeting-banner.ts';
