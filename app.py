import biplist
import glob
import itertools
import os
import urllib
import urlparse

import cherrypy
from cherrypy.lib.static import serve_file

from jinja2 import Environment, FileSystemLoader
import sh


def urlencode_filter(param):
    return urllib.quote_plus(param)

env = Environment(loader=FileSystemLoader('templates'))
env.filters['urlencode'] = urlencode_filter
repo_path = os.path.join(os.path.abspath(os.path.dirname(__file__)), 'repos')
build_path = os.path.join(os.path.abspath(os.path.dirname(__file__)), 'build')


class Root:
    def index(self):
        repos = [path for path in os.listdir(repo_path)
            if os.path.isdir(os.path.join(repo_path, path))]

        tmpl = env.get_template('index.html')
        return tmpl.render(repos=repos)


class Repo:
    def index(self, repo_name):
        # Parse the branch names from git ls-remote
        wd = os.path.join(repo_path, repo_name)
        git = sh.git.bake(_cwd=wd)
        branches = [b.strip().split('\t')[1].split('/')[-1]
                for b in git('ls-remote', '--heads')]

        tmpl = env.get_template('repo.html')
        return tmpl.render(repo_name=repo_name, branches=branches)

    def get(self, repo_name, branch, rebuild=None):
        output = os.path.join(build_path, repo_name, branch)

        tmpl = env.get_template('build.html')
        return tmpl.render(repo_name=repo_name, branch=branch,
            build=not os.path.exists(output) or rebuild,
            plist_url=urlparse.urljoin(cherrypy.url(), 'application.plist'))

    def build(self, repo_name, branch):
        cherrypy.response.headers['Content-Type'] = 'text/plain'

        wd = os.path.join(repo_path, repo_name)
        output = os.path.join(build_path, repo_name, branch)

        def generate():
            # Checkout the branch, fetch new commits and update submodules
            git = sh.git.bake(_cwd=wd)
            yield (x for x in [chr(127) * 1024 + '\nChecking out branch...\n'])
            yield git.checkout('-B', branch, '-t', 'origin/' + branch,
                    _iter=True, _out_bufsize=0)
            yield (x for x in ['Pulling from remote repository...\n'])
            yield git.pull('--ff-only', _iter=True)
            yield (x for x in ['Updating submodules...\n'])
            yield git.submodule('update', '--init',
                    _iter=True, _out_bufsize=0)

            # Do the build!
            yield (x for x in ['Starting build...\n'])
            xcodebuild = sh.xcodebuild.bake(_cwd=wd)
            yield xcodebuild.build('-configuration', 'Debug', '-arch', 'armv7',
                    '-sdk', 'iphoneos',
                    _iter=True, _out_bufsize=0)

            # Create the output folder structure if needed
            if not os.path.exists(output):
                os.makedirs(output)

            # Get the .app in the build output folder
            app_path = os.path.join(wd, glob.glob(os.path.join(wd,
                'build/Debug-iphoneos/*.app'))[0])

            # Package the .app to .ipa
            xcrun = sh.xcrun.bake(_cwd=wd)
            yield (x for x in ['Compiling app...\n'])
            yield xcrun('-sdk', 'iphoneos', 'PackageApplication', app_path,
                    '-o', os.path.join(output, 'application.ipa'),
                    _iter=True, _out_bufsize=0)

            # Write the .plist we'll need for downloading later
            yield (x for x in ['Writing plist...\n'])
            plist = biplist.readPlist(os.path.join(app_path, 'Info.plist'))
            data = {'items': [{
                'assets': [{
                    'kind': 'software-package',
                    'url': urlparse.urljoin(cherrypy.url(), 'application.ipa'),
                }],
                'metadata': {
                    'kind': 'software',
                    'bundle-identifier': plist['CFBundleIdentifier'],
                    'title': plist['CFBundleName']
                }
            }]}
            biplist.writePlist(data, os.path.join(output, 'application.plist'),
                    binary=False)

            yield (x for x in ['Done!\n'])

        return itertools.chain.from_iterable(generate())
    build._cp_config = {'response.stream': True}


if __name__ == '__main__':
    d = cherrypy.dispatch.RoutesDispatcher()
    m = d.mapper
    m.explicit = True
    m.minimization = False

    d.connect('index', '/', controller=Root(), action='index')

    repo = Repo()
    d.connect('repo', '/repo/:repo_name', controller=repo, action='index')
    d.connect('repo', '/repo/:repo_name/:branch/get', controller=repo, action='get')
    d.connect('repo', '/repo/:repo_name/:branch/build', controller=repo, action='build')

    conf = {
        '/': {'request.dispatch': d},
        '/static': {
            'tools.staticdir.on': True,
            'tools.staticdir.dir': os.path.join(os.path.dirname(os.path.abspath(__file__)) , 'static'),
        },

        'global': {
            'server.socket_host': '0.0.0.0',
        },
    }

    cherrypy.quickstart(root=None, config=conf)
