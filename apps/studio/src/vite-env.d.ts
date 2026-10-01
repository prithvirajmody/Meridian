interface ImportMetaEnv {
  /**
   * Set only by the static GitHub Pages build (`tools/build-pages.sh`): the file
   * under `samples/` that opens on load when the URL has no `?sample=`. Unset in
   * dev, tests, and the default build, so nothing loads there.
   */
  readonly VITE_MERIDIAN_DEFAULT_SAMPLE?: string;
}
