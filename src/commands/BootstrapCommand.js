import FileSystemUtilities from "../FileSystemUtilities";
import NpmUtilities from "../NpmUtilities";
import PackageUtilities from "../PackageUtilities";
import Command from "../Command";
import objectAssign from "object-assign";
import semver from "semver";
import async from "async";
import find from "lodash.find";
import path from "path";

export default class BootstrapCommand extends Command {
  initialize(callback) {
    // Nothing to do...
    callback(null, true);
  }

  execute(callback) {
    this.linkDependencies(err => {
      if (err) {
        callback(err);
      } else {
        this.logger.success("Successfully bootstrapped " + this.packages.length + " packages.");
        callback(null, true);
      }
    });
  }

  linkDependencies(callback) {
    this.progressBar.init(this.packages.length);
    this.logger.info("Linking all dependencies");

    const ignore = this.flags.ignore || this.repository.bootstrapConfig.ignore;

    // Get a filtered list of packages that will be bootstrapped.
    const todoPackages = PackageUtilities.filterPackages(this.packages, ignore, true);

    // Get a trimmed down graph that includes only those packages.
    const filteredGraph = PackageUtilities.getPackageGraph(todoPackages);

    // As packages are completed their names will go into this object.
    const donePackages = {};

    // Bootstrap runs the "prepublish" script in each package.  This script
    // may _use_ another package from the repo.  Therefore if a package in the
    // repo depends on another we need to bootstrap the dependency before the
    // dependent.  So the bootstrap proceeds in batches of packages where each
    // batch includes all packages that have no remaining un-bootstrapped
    // dependencies within the repo.
    const bootstrapBatch = () => {

      // Get all packages that have no remaining dependencies within the repo
      // that haven't yet been bootstrapped.
      const batch = todoPackages.filter(pkg => {

        const matchingDep = this.packages.find((dependency) => this.hasMatchingDependency(pkg, dependency, true));

        if (matchingDep){
          const localFileDep = "file:" + matchingDep.location;

          if(pkg._package.dependencies     && this.hasMatchingVersion(pkg._package.dependencies, matchingDep))     { pkg._package.dependencies[matchingDep.name] = localFileDep; }
          if(pkg._package.devDependencies  && this.hasMatchingVersion(pkg._package.devDependencies, matchingDep))  { pkg._package.devDependencies[matchingDep.name] = localFileDep; }
          if(pkg._package.peerDependencies && this.hasMatchingVersion(pkg._package.peerDependencies, matchingDep)) { pkg._package.peerDependencies[matchingDep.name] = localFileDep; }
        }
        const node = filteredGraph.get(pkg.name);
        return !node.dependencies.filter(dep => !donePackages[dep]).length;
      });

      async.parallelLimit(batch.map(pkg => done => {
        async.series([
          cb => FileSystemUtilities.mkdirp(pkg.nodeModulesLocation, cb),
          cb => this.installExternalPackages(pkg, cb),
          cb => this.linkDependenciesForPackage(pkg, cb),
          cb => this.runPrepublishForPackage(pkg, cb),
        ], err => {
          this.progressBar.tick(pkg.name);
          donePackages[pkg.name] = true;
          todoPackages.splice(todoPackages.indexOf(pkg), 1);
          done(err);
        });
      }), this.concurrency, err => {
        if (todoPackages.length && !err) {
          bootstrapBatch();
        } else {
          this.progressBar.terminate();
          callback(err);
        }
      });
    }

    // Kick off the first batch.
    bootstrapBatch();
  }

  runPrepublishForPackage(pkg, callback) {
    if ((pkg.scripts || {}).prepublish) {
      NpmUtilities.runScriptInDir("prepublish", [], pkg.location, callback);
    } else {
      callback();
    }
  }

  linkDependenciesForPackage(pkg, callback) {
    async.each(this.packages, (dependency, done) => {
      if (!this.hasMatchingDependency(pkg, dependency, true)) return done();

      const linkSrc = dependency.location;
      const linkDest = path.join(pkg.nodeModulesLocation, dependency.name);

      this.createLinkedDependencyFiles(linkSrc, linkDest, dependency.name, done);
    }, callback);
  }

  createLinkedDependencyFiles(src, dest, name, callback) {
    const srcPackageJsonLocation = path.join(src, "package.json");
    const destPackageJsonLocation = path.join(dest, "package.json");
    const destIndexJsLocation = path.join(dest, "index.js");

    const packageJsonFileContents = objectAssign({
      name: name,
      version: require(srcPackageJsonLocation).version,
      main: "./index.js"
    }, JSON.parse(FileSystemUtilities.readFileSync(srcPackageJsonLocation)));

    const packageJsonFileContentsStr = JSON.stringify(packageJsonFileContents, null, "  ");

    const prefix = this.repository.linkedFiles.prefix || "";
    const indexJsFileContents = prefix + "module.exports = require(" + JSON.stringify(src) + ");";

    FileSystemUtilities.writeFile(destPackageJsonLocation, packageJsonFileContentsStr, err => {
      if (err) {
        return callback(err);
      }

      FileSystemUtilities.writeFile(destIndexJsLocation, indexJsFileContents, callback);
    });
  }

  installExternalPackages(pkg, callback) {
    const allDependencies = pkg.allDependencies;

    const externalPackages = Object.keys(allDependencies)
      .filter(dependency => {
        const match = find(this.packages, pkg => {
          return pkg.name === dependency;
        });

        return !(match && this.hasMatchingDependency(pkg, match));
      })
      .filter(dependency => {
        return !this.hasDependencyInstalled(pkg, dependency);
      })
      .map(dependency => {
        return dependency + "@" + allDependencies[dependency];
      });

    if (externalPackages.length) {
      NpmUtilities.installInDir(pkg.location, externalPackages, callback);
    } else {
      callback();
    }
  }

  hasMatchingVersion(pkgDependencies, dependency) {
    const expectedVersion = pkgDependencies[dependency.name];

    const actualVersion = dependency.version;

    if (!expectedVersion) {
      return false;
    }

    if (this.isCompatableVersion(actualVersion, expectedVersion)) {
      return true;
    }

    return false;
  }

  hasMatchingDependency(pkg, dependency, showWarning = false) {
    const expectedVersion = pkg.allDependencies[dependency.name];
    const actualVersion = dependency.version;

    const hasDependency = this.hasMatchingVersion(pkg.allDependencies, dependency);

    if(dependency.version && !hasDependency && showWarning) {
      this.logger.warning(
        `Version mismatch inside "${pkg.name}". ` +
        `Depends on "${dependency.name}@${expectedVersion}" ` +
        `instead of "${dependency.name}@${actualVersion}".`
      );

      return false;
    }

    return hasDependency;
  }

  hasDependencyInstalled(pkg, dependency) {
    const packageJson = path.join(pkg.nodeModulesLocation, dependency, "package.json");
    try {
      return this.isCompatableVersion(
        require(packageJson).version,
        pkg.allDependencies[dependency]
      );
    } catch (e) {
      return false;
    }
  }

  isCompatableVersion(actual, expected) {
    return semver.satisfies(actual, expected);
  }
}
