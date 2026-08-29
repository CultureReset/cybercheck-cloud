# Test fixtures

Two apps the suite installs into a throwaway platform. They are fixtures, not
shipped apps, and they live here rather than in an `apps/` folder at the root
because a folder of apps inside the platform repo is the plugin directory this
whole design exists to avoid.

Neither manifest carries a `runtime` address. The suite supplies one at publish
time, exactly as `cc dev` and `cc publish` do, which is what proves an app is
not bound to where it happens to be served from.

To see the platform with something in it, scaffold a real app instead:

```bash
cc init ~/my-app && cd ~/my-app && cc dev
```
